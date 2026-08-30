import { createAdminClient } from "@/lib/supabase/admin";

export interface FrequencyLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/**
 * Atomically checks-and-increments a fixed-window request counter for `key`.
 *
 * Backed by the `frequency_limits` table (see supabase/migrations) rather
 * than in-process memory, for the same reason as lib/rate-limit.ts: on
 * Vercel, concurrent invocations are not guaranteed to share a process, so a
 * shared Postgres row is what makes the cap visible across every instance
 * handling a given key. Unlike lib/rate-limit.ts (which only counts
 * failures, for a brute-force lockout), every call here counts toward the
 * limit regardless of whether the caller's request ultimately succeeds --
 * this is for capping plain request frequency, e.g. how many photo uploads
 * one user can push through in a minute.
 */
export async function checkAndIncrementFrequency(
  key: string,
  maxCount: number,
  windowSeconds: number,
): Promise<FrequencyLimitResult> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .rpc("frequency_limit_check_and_increment", {
      p_key: key,
      p_max_count: maxCount,
      p_window_seconds: windowSeconds,
    })
    .single();

  if (error) {
    throw error;
  }

  return sanitizeFrequencyLimitResult({
    allowed: data.allowed,
    count: data.count,
    retryAfterSeconds: data.retry_after_seconds,
  });
}

/**
 * A backward clock jump (NTP correction, DST fold, container clock skew) can
 * make a window-based count look like it has already expired even though it
 * hasn't, which would otherwise surface here as a nonsensical negative
 * `retryAfterSeconds` or an `allowed: true` alongside a count at/over the
 * cap. Treat any such inconsistency as "deny" rather than silently letting
 * the caller through -- fail closed, not open.
 */
export function sanitizeFrequencyLimitResult(
  result: FrequencyLimitResult,
): FrequencyLimitResult {
  const inconsistent =
    result.retryAfterSeconds < 0 ||
    (result.allowed === false && result.retryAfterSeconds === 0);

  if (!inconsistent) {
    return result;
  }

  return {
    ...result,
    allowed: false,
    retryAfterSeconds: Math.max(result.retryAfterSeconds, 1),
  };
}

/**
 * Helper to clear all frequency-limit counters for a key (useful in tests).
 */
export async function clearFrequencyLimit(key: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("frequency_limits")
    .delete()
    .eq("key", key);

  if (error) {
    throw error;
  }
}
