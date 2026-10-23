/**
 * Outbox retry policy and backoff schedule (issue #688).
 *
 * Retries use capped exponential backoff with full jitter:
 *
 *   delay = random() * min(maxDelayMs, baseDelayMs * 2^(attempts - 1))
 *
 * Full jitter spreads retries out so a batch of rows that failed together does
 * not stampede the downstream dependency when the next attempt window opens.
 * `random` and `now` are injectable so the schedule can be unit-tested with a
 * fake clock and deterministic jitter.
 *
 * The policy is keyed by `${aggregate}:${event_type}`.  A per-event override
 * lets noisy or latency-sensitive event types use a different budget without
 * changing dispatcher code.  Policies are intentionally finite: a row that
 * exhausts `maxAttempts` becomes terminal (`status = 'dead'`) instead of being
 * retried forever.
 */

export interface OutboxRetryPolicy {
  /** Maximum number of handler invocations before the row is dead-lettered. */
  maxAttempts: number;
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Upper bound on any single retry delay. */
  maxDelayMs: number;
}

/** Injectable jitter source. Must return a number in [0, 1). */
export type OutboxRandom = () => number;

/** Injectable wall clock. Returns epoch milliseconds. */
export type OutboxClock = () => number;

export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
};

/**
 * Per-event overrides keyed by `${aggregate}:${event_type}`.
 *
 * Keep this small and explicit: an unbounded/very large budget defeats the
 * purpose of dead-lettering.  Unknown event types fall back to the default.
 */
export const OUTBOX_RETRY_POLICIES: Readonly<
  Record<string, OutboxRetryPolicy>
> = {
  "record_revision:record_saved": {
    maxAttempts: 8,
    baseDelayMs: 1_000,
    maxDelayMs: 15 * 60_000,
  },
};

export type OutboxRetryPolicyMap = Readonly<Record<string, OutboxRetryPolicy>>;

/** Resolve the policy for an event key, falling back to the default. */
export function getOutboxRetryPolicy(
  eventKey: string,
  policies: OutboxRetryPolicyMap = OUTBOX_RETRY_POLICIES,
  defaultPolicy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
): OutboxRetryPolicy {
  return policies[eventKey] ?? defaultPolicy;
}

function normaliseAttempt(attempts: number): number {
  if (!Number.isFinite(attempts)) return 1;
  return Math.max(1, Math.floor(attempts));
}

function normalisePolicy(policy: OutboxRetryPolicy): OutboxRetryPolicy {
  return {
    maxAttempts: Math.max(1, Math.floor(policy.maxAttempts)),
    baseDelayMs: Math.max(0, Math.floor(policy.baseDelayMs)),
    maxDelayMs: Math.max(0, Math.floor(policy.maxDelayMs)),
  };
}

/**
 * Returns the jittered delay for the next retry after `attempts` failed
 * invocations.  Attempt 1 is the first failure, so the first retry waits
 * somewhere in `[0, baseDelayMs)`.
 */
export function computeOutboxBackoffMs(
  attempts: number,
  policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
  random: OutboxRandom = Math.random,
): number {
  const attempt = normaliseAttempt(attempts);
  const { baseDelayMs, maxDelayMs } = normalisePolicy(policy);

  if (maxDelayMs === 0 || baseDelayMs === 0) return 0;

  // Cap the exponent before Math.pow so a pathological attempts value cannot
  // overflow to Infinity (which would turn jitter into NaN).
  const exponent = Math.min(attempt - 1, 30);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** exponent);

  const sample = random();
  const boundedSample = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 0.999_999_999)
    : 0;

  return Math.min(maxDelayMs, Math.floor(boundedSample * ceiling));
}

/** Returns the absolute time the next attempt becomes eligible. */
export function computeOutboxNextAttemptAt(
  nowMs: number,
  attempts: number,
  policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
  random: OutboxRandom = Math.random,
): Date {
  return new Date(nowMs + computeOutboxBackoffMs(attempts, policy, random));
}
