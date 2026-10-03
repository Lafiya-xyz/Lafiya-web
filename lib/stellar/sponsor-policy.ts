import { StrKey, Transaction, FeeBumpTransaction, Networks, TransactionBuilder, Operation, Asset, Keypair, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';

/**
 * Sponsor policy engine for CHW fee-bump sponsorship (issue #558).
 *
 * The sponsor is a server-only key that pays fees for CHW-signed inner
 * transactions. Because a fee-bump sponsor is a drain target, the policy is
 * strict: only the allowlisted attestation contract + function may be invoked,
 * the inner fee must stay under a cap, and each CHW has a daily quota.
 *
 * No PHI or capability tokens are read, logged, or forwarded here; only the
 * transaction envelope and the CHW public key are inspected.
 */

export interface SponsorPolicyConfig {
  /** Stellar network passphrase the inner transaction must target. */
  networkPassphrase: string;
  /** Contract id (C...) that the inner transaction may invoke. */
  attestationContractId: string;
  /** Function name the inner transaction may invoke on the contract. */
  attestFunctionName: string;
  /** Maximum inner transaction fee (in stroops) the sponsor will cover. */
  maxInnerFeeStroops: number;
  /** Maximum number of sponsored transactions per CHW per day. */
  dailyQuotaPerChw: number;
}

export const DEFAULT_SPONSOR_POLICY: SponsorPolicyConfig = {
  networkPassphrase: Networks.TESTNET,
  attestationContractId: '',
  attestFunctionName: 'attest',
  maxInnerFeeStroops: 1_000_000,
  dailyQuotaPerChw: 50,
};

export type PolicyRejectionReason =
  | 'malformed_envelope'
  | 'wrong_network'
  | 'not_a_soroban_invoke'
  | 'wrong_contract'
  | 'wrong_function'
  | 'fee_exceeds_cap'
  | 'quota_exceeded';

export interface PolicyDecision {
  allowed: boolean;
  reason?: PolicyRejectionReason;
  /** CHW public key (G...) that signed the inner transaction. */
  chwPublicKey?: string;
  /** Inner transaction fee in stroops, when parseable. */
  innerFeeStroops?: number;
}

/**
 * Tracks per-CHW daily sponsorship counts. Kept in-memory by default; callers
 * may inject a persistent store (e.g. the audit table) via `setQuotaStore`.
 */
export interface QuotaStore {
  getCount(chwPublicKey: string, day: string): Promise<number> | number;
  increment(chwPublicKey: string, day: string): Promise<void> | void;
}

function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

class InMemoryQuotaStore implements QuotaStore {
  private counts = new Map<string, number>();

  getCount(chwPublicKey: string, day: string): number {
    return this.counts.get(`${day}:${chwPublicKey}`) ?? 0;
  }

  increment(chwPublicKey: string, day: string): void {
    const key = `${day}:${chwPublicKey}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

/**
 * Extracts the CHW public key from the inner transaction's source account.
 * The inner transaction must be signed by the CHW; the sponsor never signs it.
 */
function extractChwPublicKey(inner: Transaction): string | undefined {
  const source = inner.source;
  if (!source) return undefined;
  try {
    return StrKey.encodeEd25519PublicKey(source.accountId().ed25519());
  } catch {
    return undefined;
  }
}

/**
 * Inspects a Soroban `invokeHostFunction` operation and returns the invoked
 * contract id + function name, or undefined when it is not a Soroban invoke.
 */
function extractInvokeTarget(
  op: Operation,
): { contractId: string; functionName: string } | undefined {
  if (op.type !== 'invokeHostFunction') return undefined;
  const hostFn = (op as Operation.InvokeHostFunction).func;
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') return undefined;
  const invokeContract = hostFn.invokeContract();
  const contractId = StrKey.encodeContract(invokeContract.contractAddress().contractId());
  const functionName = invokeContract.functionName().toString();
  return { contractId, functionName };
}

/**
 * Validates a CHW-signed inner transaction against the sponsor policy.
 * Returns a decision; the caller must not submit unless `allowed` is true.
 */
export async function evaluateSponsorPolicy(
  innerEnvelopeXdr: string,
  config: SponsorPolicyConfig = DEFAULT_SPONSOR_POLICY,
  quotaStore: QuotaStore = new InMemoryQuotaStore(),
  now: Date = new Date(),
): Promise<PolicyDecision> {
  let inner: Transaction;
  try {
    inner = new Transaction(innerEnvelopeXdr, config.networkPassphrase);
  } catch {
    return { allowed: false, reason: 'malformed_envelope' };
  }

  if (inner.networkPassphrase !== config.networkPassphrase) {
    return { allowed: false, reason: 'wrong_network' };
  }

  const chwPublicKey = extractChwPublicKey(inner);
  if (!chwPublicKey) {
    return { allowed: false, reason: 'malformed_envelope' };
  }

  const ops = inner.operations;
  if (ops.length !== 1) {
    return { allowed: false, reason: 'not_a_soroban_invoke', chwPublicKey };
  }

  const target = extractInvokeTarget(ops[0]);
  if (!target) {
    return { allowed: false, reason: 'not_a_soroban_invoke', chwPublicKey };
  }

  if (target.contractId !== config.attestationContractId) {
    return { allowed: false, reason: 'wrong_contract', chwPublicKey };
  }

  if (target.functionName !== config.attestFunctionName) {
    return { allowed: false, reason: 'wrong_function', chwPublicKey };
  }

  const innerFeeStroops = Number(inner.fee);
  if (!Number.isFinite(innerFeeStroops) || innerFeeStroops > config.maxInnerFeeStroops) {
    return { allowed: false, reason: 'fee_exceeds_cap', chwPublicKey, innerFeeStroops };
  }

  const day = utcDay(now);
  const used = await quotaStore.getCount(chwPublicKey, day);
  if (used >= config.dailyQuotaPerChw) {
    return { allowed: false, reason: 'quota_exceeded', chwPublicKey, innerFeeStroops };
  }

  return { allowed: true, chwPublicKey, innerFeeStroops };
}

/**
 * Wraps an already-validated inner transaction in a fee bump signed by the
 * sponsor key. The inner transaction's signatures are preserved untouched.
 */
export function buildFeeBump(
  innerEnvelopeXdr: string,
  sponsorKeypair: Keypair,
  config: SponsorPolicyConfig = DEFAULT_SPONSOR_POLICY,
  baseFeeStroops = 100,
): FeeBumpTransaction {
  const inner = TransactionBuilder.fromXDR(
    innerEnvelopeXdr,
    config.networkPassphrase,
  ) as Transaction;

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair,
    String(baseFeeStroops),
    inner,
    config.networkPassphrase,
  );
  feeBump.sign(sponsorKeypair);
  return feeBump;
}

/**
 * Records a successful sponsorship against the CHW's daily quota. Call this
 * only after the fee-bump has been accepted for submission.
 */
export async function recordSponsoredTransaction(
  chwPublicKey: string,
  quotaStore: QuotaStore = new InMemoryQuotaStore(),
  now: Date = new Date(),
): Promise<void> {
  await quotaStore.increment(chwPublicKey, utcDay(now));
}

/**
 * Low-balance monitor for the sponsor account. Returns true when the sponsor
 * balance has fallen to or below the configured threshold.
 */
export function isSponsorBalanceLow(
  sponsorBalanceStroops: number,
  lowBalanceThresholdStroops: number,
): boolean {
  return sponsorBalanceStroops <= lowBalanceThresholdStroops;
}

export const DEFAULT_LOW_BALANCE_THRESHOLD_STROOPS = 10_000_000;

/**
 * Builds a low-balance alert payload for the sponsor account. Contains no PHI
 * or capability tokens — only the sponsor public key and balance figures.
 */
export function buildLowBalanceAlert(
  sponsorPublicKey: string,
  sponsorBalanceStroops: number,
  thresholdStroops: number = DEFAULT_LOW_BALANCE_THRESHOLD_STROOPS,
): { sponsorPublicKey: string; balanceStroops: number; thresholdStroops: number; message: string } | null {
  if (!isSponsorBalanceLow(sponsorBalanceStroops, thresholdStroops)) return null;
  return {
    sponsorPublicKey,
    balanceStroops: sponsorBalanceStroops,
    thresholdStroops,
    message: `Sponsor account ${sponsorPublicKey} balance is low (${sponsorBalanceStroops} stroops <= ${thresholdStroops}).`,
  };
}

/**
 * Reads the sponsor secret from the server-only environment. Never expose this
 * value to the client or log it.
 */
export function loadSponsorKeypair(secretEnv: string | undefined = process.env.CHW_SPONSOR_SECRET): Keypair {
  if (!secretEnv) {
    throw new Error('CHW_SPONSOR_SECRET is not configured');
  }
  return Keypair.fromSecret(secretEnv);
}

/**
 * Builds the Soroban data / asset placeholders used when constructing a
 * fee-bump for a Soroban inner transaction. Exposed for tests.
 */
export function sorobanFeeBumpData(): SorobanDataBuilder {
  return new SorobanDataBuilder();
}

export { Asset, xdr };
