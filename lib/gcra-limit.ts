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
 * `limiterHeaders()` produces the standard `RateLimit-*` / `Retry-After`
 * headers described in draft-ietf-httpapi-ratelimit-headers-08.
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
 * Produce standard `RateLimit-*` and (when denied) `Retry-After` headers
 * from a `LimiterResult`.
 *
 * Follows draft-ietf-httpapi-ratelimit-headers-08:
 * - `RateLimit-Limit`: the request quota.
 * - `RateLimit-Remaining`: remaining quota.
 * - `RateLimit-Reset`: seconds until reset (relative, as per the draft).
 * - `Retry-After`: seconds to wait (only when denied).
 */
export function limiterHeaders(
  result: LimiterResult,
  burst: number,
): Record<string, string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetIn = Math.max(0, result.resetAt - nowSeconds);

  const hdrs: Record<string, string> = {
    "RateLimit-Limit": String(burst),
    "RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "RateLimit-Reset": String(resetIn),
  };

  if (!result.allowed) {
    hdrs["Retry-After"] = String(Math.max(1, result.retryAfter));
  }

  return hdrs;
}
