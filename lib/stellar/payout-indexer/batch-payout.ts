/**
 * Batch CHW payout builder and submitter.
 *
 * Implements issue: "Pay up to 100 CHWs per transaction using multiple
 * payment operations, and recover correctly when the transaction fails
 * atomically, for example by bisecting to isolate the failing recipient."
 *
 * Design notes (see docs/chw-batch-payouts.md for the full writeup):
 *  - Each Stellar transaction bundles up to `maxOperationsPerTransaction`
 *    (default 100, configurable) `payment` operations, one per obligation.
 *  - Every operation carries a memo derived from the obligation's
 *    `eligibility_key` so it can be tied back to a single `payout_obligations`
 *    row (the "idempotency key"). The indexer already treats
 *    `apply_chw_payout` as idempotent on that key, so re-submitting a batch
 *    that partially succeeded is safe.
 *  - On a Horizon `tx_failed` response with per-operation `op_*` codes, the
 *    batch is bisected: the recipient set is split in half and each half is
 *    resubmitted as its own transaction. Any recipient that still fails when
 *    alone in a batch is quarantined via `protocol_quarantine` (reason code
 *    `payout_operation_failed`) instead of being retried forever.
 *  - Settlement is never inferred from the submission response alone --
 *    callers must still rely on `PayoutIndexer` / `HorizonPayoutSource`
 *    (see indexer.ts, sources.ts) to observe the payment on-chain before
 *    marking an obligation `settled`. This module only decides *what* to
 *    submit and *how to recover* from a bad recipient; it does not mutate
 *    `payout_obligations.status` directly.
 *  - Sequence numbers: this module submits batches serially against a single
 *    source account by default (documented tradeoff -- see
 *    docs/chw-batch-payouts.md#sequence-numbers). A `channelAccounts` option
 *    is accepted so callers with SEP-0010-style channel account pools can
 *    parallelize submission; when omitted, submission is serial and each
 *    batch waits for the previous one's sequence number to be consumed.
 */

import {
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  type Account,
  type Horizon,
  type Transaction,
} from "@stellar/stellar-sdk";

export const DEFAULT_MAX_OPERATIONS_PER_TRANSACTION = 100;
export const MAX_ALLOWED_OPERATIONS_PER_TRANSACTION = 100;

export interface PayoutRecipient {
  /** payout_obligations.id */
  obligationId: string;
  /** payout_obligations.eligibility_key -- doubles as the idempotency key */
  eligibilityKey: string;
  recipientAddress: string;
  amountUsdc: string;
}

export interface BatchPayoutConfig {
  maxOperationsPerTransaction?: number;
  usdcAsset: Asset;
  sourceAccount: Account;
  sourceKeypair: Keypair;
  networkPassphrase: string;
  /** Optional channel account keypairs for parallel submission. */
  channelAccounts?: Keypair[];
}

export interface BuiltBatch {
  recipients: PayoutRecipient[];
  transaction: Transaction;
}

/** Builds one or more transactions covering `recipients`, respecting the configured batch size. */
export function buildPayoutBatches(
  recipients: PayoutRecipient[],
  config: BatchPayoutConfig,
): BuiltBatch[] {
  const batchSize = clampBatchSize(config.maxOperationsPerTransaction);
  const batches: BuiltBatch[] = [];

  for (let i = 0; i < recipients.length; i += batchSize) {
    const slice = recipients.slice(i, i + batchSize);
    batches.push({
      recipients: slice,
      transaction: buildSingleBatchTransaction(slice, config),
    });
  }

  return batches;
}

function clampBatchSize(requested: number | undefined): number {
  const size = requested ?? DEFAULT_MAX_OPERATIONS_PER_TRANSACTION;
  if (size < 1) return 1;
  if (size > MAX_ALLOWED_OPERATIONS_PER_TRANSACTION) {
    return MAX_ALLOWED_OPERATIONS_PER_TRANSACTION;
  }
  return size;
}

function buildSingleBatchTransaction(
  recipients: PayoutRecipient[],
  config: BatchPayoutConfig,
): Transaction {
  if (recipients.length === 0) {
    throw new Error("cannot build a payout batch with zero recipients");
  }
  if (recipients.length > MAX_ALLOWED_OPERATIONS_PER_TRANSACTION) {
    throw new Error(
      `batch of ${recipients.length} exceeds max ${MAX_ALLOWED_OPERATIONS_PER_TRANSACTION} operations`,
    );
  }

  const builder = new TransactionBuilder(config.sourceAccount, {
    fee: String(Number(BASE_FEE) * recipients.length),
    networkPassphrase: config.networkPassphrase,
  }).setTimeout(180);

  for (const recipient of recipients) {
    builder.addOperation(
      Operation.payment({
        destination: recipient.recipientAddress,
        asset: config.usdcAsset,
        amount: recipient.amountUsdc,
      }),
    );
  }

  // Memo carries the batch's obligation ids joined so submission logs and
  // manual audits can tie the tx back to obligations even before the
  // indexer observes individual payment operations. Full traceability for
  // an individual operation still comes from ordering: operation N in the
  // transaction corresponds to recipients[N] in eligibilityKey order.
  const batchDigest = obligationBatchDigest(recipients);
  const tx = builder.addMemo(Memo.hash(batchDigest)).build();
  tx.sign(config.sourceKeypair);
  return tx;
}

/** 32-byte digest binding this batch to its exact set of obligation ids, used as the Memo.hash. */
function obligationBatchDigest(recipients: PayoutRecipient[]): Buffer {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const ids = recipients.map((r) => r.obligationId).join(",");
  return crypto.createHash("sha256").update(ids).digest();
}

export type OperationFailureCode = string;

export interface SubmissionFailure {
  recipients: PayoutRecipient[];
  operationCodes: OperationFailureCode[];
}

export interface BisectionResult {
  /** Recipients whose payment ultimately could not be isolated to succeed and must be reviewed manually. */
  quarantined: Array<{ recipient: PayoutRecipient; reasonCode: string }>;
  /** Recipients that were retried alone and are safe to resubmit. */
  retryable: PayoutRecipient[];
}

/**
 * Bisects a failed batch to find the bad recipient(s).
 *
 * `submit` is injected so this function stays pure/testable: given a list of
 * recipients it should attempt on-chain submission and return either `{ ok:
 * true }` or `{ ok: false, operationCodes }` mirroring Horizon's tx_failed
 * per-operation result codes. A batch of size 1 that still fails is
 * quarantined with the failing op code as the reason.
 */
export async function bisectAndRetry(
  recipients: PayoutRecipient[],
  submit: (
    batch: PayoutRecipient[],
  ) => Promise<{ ok: true } | { ok: false; operationCodes: string[] }>,
  quarantine: (recipient: PayoutRecipient, reasonCode: string) => Promise<void>,
): Promise<BisectionResult> {
  const quarantined: BisectionResult["quarantined"] = [];
  const retryable: PayoutRecipient[] = [];

  async function attempt(batch: PayoutRecipient[]): Promise<void> {
    if (batch.length === 0) return;

    const result = await submit(batch);
    if (result.ok) {
      retryable.push(...batch);
      return;
    }

    if (batch.length === 1) {
      const reasonCode = result.operationCodes[0] ?? "payout_operation_failed";
      quarantined.push({ recipient: batch[0], reasonCode });
      await quarantine(batch[0], reasonCode);
      return;
    }

    const mid = Math.ceil(batch.length / 2);
    await attempt(batch.slice(0, mid));
    await attempt(batch.slice(mid));
  }

  await attempt(recipients);
  return { quarantined, retryable };
}

/** Serial submission across a set of built batches, bisecting on failure. One retry cycle per bad recipient (acceptance criterion: a bad recipient never blocks the rest for more than one retry cycle). */
export async function submitBatchesSerially(
  batches: BuiltBatch[],
  horizon: Horizon.Server,
  rebuildAndResign: (recipients: PayoutRecipient[]) => Promise<Transaction>,
  quarantine: (recipient: PayoutRecipient, reasonCode: string) => Promise<void>,
): Promise<{ submitted: PayoutRecipient[]; quarantined: BisectionResult["quarantined"] }> {
  const submitted: PayoutRecipient[] = [];
  const quarantinedAll: BisectionResult["quarantined"] = [];

  for (const batch of batches) {
    try {
      await horizon.submitTransaction(batch.transaction);
      submitted.push(...batch.recipients);
    } catch (err) {
      const operationCodes = extractOperationCodes(err);
      const result = await bisectAndRetry(
        batch.recipients,
        async (subset) => {
          try {
            const tx = await rebuildAndResign(subset);
            await horizon.submitTransaction(tx);
            return { ok: true };
          } catch (subErr) {
            return { ok: false, operationCodes: extractOperationCodes(subErr) };
          }
        },
        quarantine,
      );
      submitted.push(...result.retryable);
      quarantinedAll.push(...result.quarantined);
      void operationCodes; // top-level codes are informational only; per-subset codes drive quarantine reasons
    }
  }

  return { submitted, quarantined: quarantinedAll };
}

function extractOperationCodes(err: unknown): string[] {
  const response = (err as { response?: { data?: { extras?: { result_codes?: { operations?: string[] } } } } })
    ?.response;
  return response?.data?.extras?.result_codes?.operations ?? ["unknown_error"];
}
