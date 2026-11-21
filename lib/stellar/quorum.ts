import { logWarn } from "@/lib/logging/logger";

/**
 * Quorum-read attestations across independent Soroban RPC providers (Issue #895).
 *
 * A single RPC provider is a single point of trust: a lying or lagging provider
 * can make an unverified record look "verified". This module fans a read out to
 * at least two independent providers in parallel, each with its own
 * `AbortController` timeout, and only reports `verified` when the decoded
 * entries agree and the observed `latestLedger` values are within a skew
 * tolerance. Anything else is `verification_inconclusive` — never verified.
 *
 * The caller is responsible for coalescing/caching (see
 * `lib/stellar/attestation.ts`, which wraps this in the existing
 * `Singleflight` + `unstable_cache`), so a fan-out costs one round of parallel
 * requests per cache miss, not per request.
 */

/** Per-provider deadline for a quorum read. */
export const QUORUM_PROVIDER_TIMEOUT_MS = 2000;

/** Maximum `latestLedger` difference between providers still considered agreeing. */
export const QUORUM_LEDGER_SKEW_TOLERANCE = 5;

export type QuorumOutcome = "verified" | "verification_inconclusive";

export interface QuorumProviderResult<T> {
  /** Stable, non-secret provider label (hostname) for metrics/logs. */
  provider: string;
  value: T | null;
  latestLedger: number;
}

export interface QuorumReadResult<T> {
  outcome: QuorumOutcome;
  /** Agreed value when `outcome === "verified"`, otherwise `null`. */
  value: T | null;
  /** Ledger the agreed value was observed at, when verified. */
  latestLedger: number | null;
  /** Provider whose result was used (first agreeing provider), when verified. */
  provider: string | null;
  /** Machine-readable reason for an inconclusive outcome. */
  reason: QuorumInconclusiveReason | null;
  /** Number of providers that answered successfully. */
  answered: number;
}

export type QuorumInconclusiveReason =
  | "insufficient_providers"
  | "insufficient_responses"
  | "entry_mismatch"
  | "ledger_skew";

/** Process-lifetime disagreement counters, exported for metrics scraping. */
export const quorumMetrics = {
  reads: 0,
  verified: 0,
  inconclusive: 0,
  disagreements: 0,
  byReason: {
    insufficient_providers: 0,
    insufficient_responses: 0,
    entry_mismatch: 0,
    ledger_skew: 0,
  } as Record<QuorumInconclusiveReason, number>,
};

function recordInconclusive(reason: QuorumInconclusiveReason): void {
  quorumMetrics.inconclusive++;
  quorumMetrics.byReason[reason]++;
  if (reason === "entry_mismatch" || reason === "ledger_skew") {
    quorumMetrics.disagreements++;
    // Alert signal: providers disagree about on-chain state. Never includes
    // the record hash or any capability token.
    logWarn("Attestation quorum disagreement", {
      metric: "attestation_quorum_disagreement",
      reason,
      disagreements: quorumMetrics.disagreements,
    });
  }
}

/** Stable provider label: hostname only, never the full URL or credentials. */
export function providerLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/**
 * Run `read` against every provider in parallel with a per-provider timeout.
 * Rejected/timed-out providers are dropped; the rest are returned.
 */
export async function readFromProviders<T>(
  providers: readonly string[],
  read: (provider: string, signal: AbortSignal) => Promise<QuorumProviderResult<T>>,
  timeoutMs: number = QUORUM_PROVIDER_TIMEOUT_MS,
): Promise<QuorumProviderResult<T>[]> {
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("quorum provider timeout"));
          reject(new Error("quorum provider timeout"));
        }, timeoutMs);
      });
      try {
        return await Promise.race([read(provider, controller.signal), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  return settled
    .filter(
      (result): result is PromiseFulfilledResult<QuorumProviderResult<T>> =>
        result.status === "fulfilled",
    )
    .map((result) => result.value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare provider results and decide the quorum outcome.
 *
 * Verified requires at least two successful responses whose decoded entries are
 * identical and whose `latestLedger` values are within `skewTolerance`.
 */
export function evaluateQuorum<T>(
  results: readonly QuorumProviderResult<T>[],
  options: { minProviders?: number; skewTolerance?: number } = {},
): QuorumReadResult<T> {
  const minProviders = options.minProviders ?? 2;
  const skewTolerance = options.skewTolerance ?? QUORUM_LEDGER_SKEW_TOLERANCE;

  const inconclusive = (
    reason: QuorumInconclusiveReason,
    answered: number,
  ): QuorumReadResult<T> => {
    recordInconclusive(reason);
    return {
      outcome: "verification_inconclusive",
      value: null,
      latestLedger: null,
      provider: null,
      reason,
      answered,
    };
  };

  if (results.length < minProviders) {
    return inconclusive("insufficient_responses", results.length);
  }

  const [first, ...rest] = results;
  const agreeing = rest.filter(
    (result) =>
      sameValue(result.value, first.value) &&
      Math.abs(result.latestLedger - first.latestLedger) <= skewTolerance,
  );

  if (agreeing.length === 0) {
    const anySameEntry = rest.some((result) => sameValue(result.value, first.value));
    return inconclusive(anySameEntry ? "ledger_skew" : "entry_mismatch", results.length);
  }

  quorumMetrics.verified++;
  return {
    outcome: "verified",
    value: first.value,
    latestLedger: first.latestLedger,
    provider: first.provider,
    reason: null,
    answered: results.length,
  };
}

/**
 * Full quorum read: fan out, then evaluate. Fewer than `minProviders`
 * configured providers is itself inconclusive — a single provider can never
 * produce a "verified" result.
 */
export async function quorumRead<T>(
  providers: readonly string[],
  read: (provider: string, signal: AbortSignal) => Promise<QuorumProviderResult<T>>,
  options: {
    minProviders?: number;
    skewTolerance?: number;
    timeoutMs?: number;
  } = {},
): Promise<QuorumReadResult<T>> {
  const minProviders = options.minProviders ?? 2;
  if (providers.length < minProviders) {
    recordInconclusive("insufficient_providers");
    return {
      outcome: "verification_inconclusive",
      value: null,
      latestLedger: null,
      provider: null,
      reason: "insufficient_providers",
      answered: 0,
    };
  }

  const results = await readFromProviders(providers, read, options.timeoutMs);
  quorumMetrics.reads++;
  return evaluateQuorum(results, {
    minProviders,
    skewTolerance: options.skewTolerance,
  });
}
