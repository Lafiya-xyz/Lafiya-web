/**
 * Generic Cell Rate Algorithm (GCRA) rate-limiter abstraction (issue #793).
 *
 * Provides a single `LimiterResult` interface and a Postgres-backed GCRA
 * implementation that all rate/frequency limiting call sites can migrate to.
 * Existing `lib/rate-limit.ts` (failure-backoff lockouts) and
 * `lib/frequency-limit.ts` (fixed-window counters) remain as thin wrappers
 * until their call sites are migrated; new call sites should use this module.
 *
 * ## Algorithm
 * GCRA (also known as the "leaky bucket as a meter") models a virtual
 * scheduling queue. For a limit of `burst` requests per `periodSeconds`:
 *   - `emission_interval` = periodSeconds / burst
 *   - `tat` (theoretical arrival time) is stored per key in Postgres.
 *   - On each request the new TAT is max(now, tat) + emission_interval.
 *   - If new_tat - now > burst * emission_interval the request is denied.
 *
 * This gives smooth bursting without fixed windows, making it harder to
 * game with boundary-timing attacks.
 *
 * ## Postgres backing
 * The `gcra_consume` SQL function (see migration
 * `20261022120000_gcra_rate_limits.sql`) performs the GCRA arithmetic
 * atomically in a single `INSERT … ON CONFLICT DO UPDATE` so concurrent
 * calls from multiple Vercel instances never race.
 *
 * ## Standard headers
 * `limiterHeaders()` produces the standard `RateLimit` / `RateLimit-Policy`
 * headers described in draft-ietf-httpapi-ratelimit-headers-08, plus
 * `Retry-After` when the request is denied (issue #939).
 */

import { createAdminClient } from "@/lib/supabase/admin";

// ─── Public interface ────────────────────────────────────────────────────────

/**
 * The result returned by every limiter call site.
 * Supersedes the ad-hoc shapes in `RateLimitResult` and `FrequencyLimitResult`.
 */
export interface LimiterResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining quota in the current window (0 when denied). */
  remaining: number;
  /**
   * Seconds the caller must wait before retrying (0 when allowed).
   * Suitable for `Retry-After` header.
   */
  retryAfter: number;
  /** Unix timestamp (seconds) at which the window resets. */
  resetAt: number;
}

// ─── GCRA consume ────────────────────────────────────────────────────────────

/**
 * Consume `cost` tokens from the GCRA bucket for `key`.
 *
 * @param key          Opaque rate-limit key (never raw PHI — use hashed or
 *                     aggregate identifiers).
 * @param burst        Maximum burst size (number of requests allowed in a
 *                     single emission interval).
 * @param periodSeconds Window length in seconds.
 * @param cost         Number of tokens to consume (default 1).
 */
export async function gcraConsume(
  key: string,
  burst: number,
  periodSeconds: number,
  cost = 1,
): Promise<LimiterResult> {
  const supabase = createAdminClient({ purpose: "rate-limit" });
  const { data, error } = await supabase
    .rpc("gcra_consume", {
      p_key: key,
      p_burst: burst,
      p_period_seconds: periodSeconds,
      p_cost: cost,
    })
    .single();

  if (error) {
    throw error;
  }

  const row = data as {
    allowed: boolean;
    remaining: number;
    retry_after_seconds: number;
    reset_at: string;
  };

  return {
    allowed: row.allowed,
    remaining: row.remaining,
    retryAfter: row.retry_after_seconds,
    resetAt: Math.floor(new Date(row.reset_at).getTime() / 1000),
  };
}

// ─── Standard headers ────────────────────────────────────────────────────────

/**
 * Produce standard `RateLimit` / `RateLimit-Policy` and (when denied)
 * `Retry-After` headers from a `LimiterResult`.
 *
 * Follows draft-ietf-httpapi-ratelimit-headers-08 (issue #939):
 * - `RateLimit-Policy`: the quota policy, e.g. `"60;w=60"` (quota;window).
 * - `RateLimit`: the current state, e.g. `"60;w=60, 42, 18"` — quota,
 *   remaining quota and seconds until reset (relative, as per the draft).
 * - `Retry-After`: seconds to wait (only when denied).
 *
 * The legacy `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`
 * fields are emitted alongside for clients written against the earlier
 * draft; they carry the same values.
 */
export function limiterHeaders(
  result: LimiterResult,
  burst: number,
  periodSeconds?: number,
): Record<string, string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetIn = Math.max(0, result.resetAt - nowSeconds);
  const remaining = Math.max(0, result.remaining);
  const window = periodSeconds ? `;w=${periodSeconds}` : "";

  const hdrs: Record<string, string> = {
    "RateLimit-Policy": `${burst}${window}`,
    RateLimit: `${burst}${window}, ${remaining}, ${resetIn}`,
    "RateLimit-Limit": String(burst),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(resetIn),
  };

  if (!result.allowed) {
    hdrs["Retry-After"] = String(Math.max(1, result.retryAfter));
  }

  return hdrs;
}

/**
 * Produce the same standard headers from a fixed-window counter result
 * (`lib/frequency-limit.ts`), so public JSON APIs that still use the
 * fixed-window limiter emit an identical header shape (issue #939).
 */
export function fixedWindowHeaders(
  result: { allowed: boolean; count: number; retryAfterSeconds: number },
  maxCount: number,
  windowSeconds: number,
): Record<string, string> {
  const remaining = Math.max(0, maxCount - result.count);
  const resetIn = result.allowed ? windowSeconds : Math.max(0, result.retryAfterSeconds);

  const hdrs: Record<string, string> = {
    "RateLimit-Policy": `${maxCount};w=${windowSeconds}`,
    RateLimit: `${maxCount};w=${windowSeconds}, ${remaining}, ${resetIn}`,
    "RateLimit-Limit": String(maxCount),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(resetIn),
  };

  if (!result.allowed) {
    hdrs["Retry-After"] = String(Math.max(1, result.retryAfterSeconds));
  }

  return hdrs;
}
