import {
  Address,
  FeeBumpTransaction,
  Horizon,
  scValToNative,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";

import type {
  AttestationEvent,
  AttestationSource,
  EventPage,
  PayoutEvent,
  PayoutSource,
} from "./types";
import { BoundedMap } from "@/lib/bounded-map";
import { Asset } from "@/lib/stellar/assets";

const RECORD_HASH_PATTERN = /^[0-9a-f]{64}$/;

const TRUSTLINE_CACHE_TTL_MS = 5 * 60 * 1000;

export type TrustlineStatus =
  | "healthy"
  | "no_account"
  | "no_trustline"
  | "zero_limit"
  | "unauthorized";

/**
 * SEP-29: an account that requires a memo on every incoming payment. Payouts
 * to such accounts must carry the payout reference memo (they always do), and
 * a missing memo is a hard failure rather than a silent drop.
 */
export interface MemoRequiredCheck {
  memoRequired: boolean;
  /** SEP-29 `config.memo_required` value when the account advertises one. */
  configValue: string | null;
}

export interface TrustlineCheck {
  status: TrustlineStatus;
  authorized: boolean;
  limit: string | null;
  balance: string | null;
}

interface CachedTrustlineCheck {
  expiresAt: number;
  check: TrustlineCheck;
}

interface CachedMemoRequiredCheck {
  expiresAt: number;
  check: MemoRequiredCheck;
}

/**
 * SEP-29 memo-required detection from an account's `data` entries. The
 * `config.memo_required` data entry is present (any value) when the account
 * requires a memo on incoming payments.
 */
export function memoRequiredFromAccountData(
  data: Record<string, string> | undefined | null,
): MemoRequiredCheck {
  const value = data?.["config.memo_required"];
  return {
    memoRequired: value !== undefined && value !== null,
    configValue: value ?? null,
  };
}

export function recordHashFromMemo(
  memoType: string,
  memo: string,
): string | null {
  if (memoType !== "hash") return null;
  const normalized = memo.toLowerCase();
  if (RECORD_HASH_PATTERN.test(normalized)) return normalized;
  try {
    const decoded = Buffer.from(memo, "base64").toString("hex");
    return RECORD_HASH_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function operationsFromEnvelope(
  envelope: xdr.TransactionEnvelope,
  networkPassphrase: string,
) {
  const transaction = TransactionBuilder.fromXDR(
    envelope.toXDR("base64"),
    networkPassphrase,
  );
  return transaction instanceof FeeBumpTransaction
    ? transaction.innerTransaction.operations
    : transaction.operations;
}

export class SorobanAttestationSource implements AttestationSource {
  private readonly server: rpc.Server;

  constructor(
    rpcUrl: string,
    private readonly contractId: string,
    private readonly networkPassphrase: string,
    private readonly pageSize = 100,
  ) {
    this.server = new rpc.Server(rpcUrl, {
      allowHttp: new URL(rpcUrl).protocol === "http:",
    });
  }

  async read(
    cursor: string | null,
    startLedger: number,
  ): Promise<EventPage<AttestationEvent>> {
    const response = await this.server.getTransactions(
      cursor
        ? { pagination: { cursor, limit: this.pageSize } }
        : { startLedger, pagination: { limit: this.pageSize } },
    );
    const events: AttestationEvent[] = [];

    for (const transaction of response.transactions) {
      if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) continue;
      for (const operation of operationsFromEnvelope(
        transaction.envelopeXdr,
        this.networkPassphrase,
      )) {
        if (operation.type !== "invokeHostFunction") continue;
        if (operation.func.switch().name !== "hostFunctionTypeInvokeContract") {
          continue;
        }
        const invocation = operation.func.invokeContract();
        if (
          Address.fromScAddress(invocation.contractAddress()).toString() !==
            this.contractId ||
          invocation.functionName().toString() !== "attest"
        ) {
          continue;
        }
        const args = invocation.args();
        if (args.length < 3) continue;
        const recordHashValue = scValToNative(args[0]);
        const attesterValue = scValToNative(args[1]);
        const timestampValue = scValToNative(args[2]);
        const recordHash = Buffer.isBuffer(recordHashValue)
          ? recordHashValue.toString("hex")
          : "";
        const stellarAddress = String(attesterValue);
        const timestamp = Number(timestampValue);
        if (
          !RECORD_HASH_PATTERN.test(recordHash) ||
          !Number.isSafeInteger(timestamp)
        ) {
          continue;
        }
        events.push({
          recordHash,
          stellarAddress,
          attestedAt: new Date(timestamp * 1000).toISOString(),
          transactionHash: transaction.txHash,
          ledger: transaction.ledger,
        });
      }
    }
    return { events, cursor: response.cursor };
  }
}

export class HorizonPayoutSource implements PayoutSource {
  private readonly server: Horizon.Server;
  // TTL-checked on read; bounded so expired entries cannot accumulate.
  private readonly trustlineCache = new BoundedMap<string, CachedTrustlineCheck>(
    10_000,
  );
  // SEP-29 memo-required flags, same TTL/bounds as the trustline cache.
  private readonly memoRequiredCache = new BoundedMap<
    string,
    CachedMemoRequiredCheck
  >(10_000);

  private readonly usdc: Asset;

  constructor(
    horizonUrl: string,
    private readonly poolAddress: string,
    usdcIssuer: string,
    private readonly pageSize = 100,
    usdcAssetCode = "USDC",
  ) {
    this.usdc = Asset.of(usdcAssetCode, usdcIssuer);
    this.server = new Horizon.Server(horizonUrl, {
      allowHttp: new URL(horizonUrl).protocol === "http:",
    });
  }

  /**
   * Preflight a payout recipient's USDC trustline before settlement.
   * Results are cached for 5 minutes to avoid hammering Horizon.
   */
  async checkTrustline(stellarAddress: string): Promise<TrustlineCheck> {
    const cached = this.trustlineCache.get(stellarAddress);
    if (cached && cached.expiresAt > Date.now()) return cached.check;

    let check: TrustlineCheck;
    try {
      const account = await this.server.accounts().accountId(stellarAddress).call();
      const trustline = account.balances.find((balance) =>
        this.usdc.matchesHorizonAsset(balance),
      );
      if (!trustline) {
        check = {
          status: "no_trustline",
          authorized: false,
          limit: null,
          balance: null,
        };
      } else {
        const limit = trustline.limit ?? "0";
        const authorized = trustline.is_authorized !== false;
        let status: TrustlineStatus = "healthy";
        if (!authorized) status = "unauthorized";
        else if (Number(limit) <= 0) status = "zero_limit";
        check = {
          status,
          authorized,
          limit,
          balance: trustline.balance ?? null,
        };
      }
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) {
        check = {
          status: "no_account",
          authorized: false,
          limit: null,
          balance: null,
        };
      } else {
        throw error;
      }
    }

    this.trustlineCache.set(stellarAddress, {
      expiresAt: Date.now() + TRUSTLINE_CACHE_TTL_MS,
      check,
    });
    return check;
  }

  /**
   * Returns true only when the recipient can receive USDC right now.
   */
  async canReceiveUsdc(stellarAddress: string): Promise<boolean> {
    const check = await this.checkTrustline(stellarAddress);
    return check.status === "healthy";
  }

  /**
   * SEP-29 preflight: does this recipient require a memo on incoming payments?
   * Cached for 5 minutes like the trustline check. A missing account is not
   * memo-required (the payment will fail on `no_account` instead).
   */
  async checkMemoRequired(stellarAddress: string): Promise<MemoRequiredCheck> {
    const cached = this.memoRequiredCache.get(stellarAddress);
    if (cached && cached.expiresAt > Date.now()) return cached.check;

    let check: MemoRequiredCheck;
    try {
      const account = await this.server.accounts().accountId(stellarAddress).call();
      check = memoRequiredFromAccountData(account.data);
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response
        ?.status;
      if (status !== 404) throw error;
      check = { memoRequired: false, configValue: null };
    }

    this.memoRequiredCache.set(stellarAddress, {
      expiresAt: Date.now() + TRUSTLINE_CACHE_TTL_MS,
      check,
    });
    return check;
  }

  async read(
    cursor: string | null,
    startCursor = "0",
  ): Promise<EventPage<PayoutEvent>> {
    const page = await this.server
      .payments()
      .forAccount(this.poolAddress)
      .cursor(cursor ?? startCursor)
      .order("asc")
      .limit(this.pageSize)
      .call();
    const events: PayoutEvent[] = [];

    for (const operation of page.records) {
      if (
        operation.type !== "payment" ||
        operation.from !== this.poolAddress ||
        operation.asset_code !== "USDC" ||
        operation.asset_issuer !== this.usdcIssuer
      ) {
        continue;
      }
      const transaction = await operation.transaction();
      const memoReference = recordHashFromMemo(
        transaction.memo_type,
        transaction.memo ?? "",
      );
      // SEP-29: a memo-required recipient must never be settled from a
      // memo-less payment -- there is no reference to reconcile against.
      if (!memoReference) continue;
      events.push({
        recordHash: memoReference,
        stellarAddress: operation.to,
        amountUsdc: operation.amount,
        transactionHash: operation.transaction_hash,
        paidAt: operation.created_at,
        pagingToken: operation.paging_token,
        memoReference,
      });
    }

    return {
      events,
      cursor: page.records.at(-1)?.paging_token ?? cursor ?? startCursor,
    };
  }
}
