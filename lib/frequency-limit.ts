import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Concrete per-feature limit values (maxCount, windowSeconds) are defined as
 * named constants at each call site (e.g. UPLOAD_FREQUENCY_MAX,
 * UPLOAD_FREQUENCY_WINDOW_SECONDS in app/api/profile/photo/route.ts) so each
 * caller's policy is self-documented alongside the code that enforces it.
 * This file intentionally contains no hardcoded limit numbers — all numeric
 * parameters are passed in by the caller.
 */

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

  return {
    allowed: data.allowed,
    count: data.count,
    retryAfterSeconds: data.retry_after_seconds,
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
