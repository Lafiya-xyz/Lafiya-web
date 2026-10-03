import { isIP } from "node:net";

import { headers } from "next/headers";

import { getRuntimeConfig } from "@/lib/runtime-config";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Milliseconds per second — used to convert a future timestamp (ms) to a
 * seconds-remaining countdown for callers and Retry-After headers.
 */
export const MS_PER_SECOND = 1000;

/**
 * Fallback client IP returned when no forwarding headers are present.
 * Matches the loopback address used by local dev and CI environments.
 */
export const FALLBACK_CLIENT_IP = "127.0.0.1";

/**
 * The backoff schedule (first lockout duration, cap, and free-attempt
 * threshold) lives in the `rate_limit_record_failure()` Postgres function
 * defined in supabase/migrations/20260729120001_rate_limits_table.sql.
 * Constants are not duplicated here to keep a single source of truth;
 * change them there, not here.
 *
 * Summary for reference:
 *   - Attempts 1–4: no lockout.
 *   - Attempt 5: locked out for 30 s.
 *   - Attempts 6+: exponential doubling (30 s × 2^(n-5)), capped at 900 s (15 min).
 */

export interface RateLimitResult {
  allowed: boolean;
  blockedUntil: Date | null;
  secondsRemaining: number;
}

/**
 * Checks if a given key is currently rate-limited/blocked.
 *
 * Backed by the `rate_limits` table (see supabase/migrations) rather than
 * in-process memory: on Vercel, concurrent Server Action invocations are not
 * guaranteed to share a process, so a single shared Postgres row is what
 * actually makes the lockout visible across every instance handling a given
 * key. This is a single indexed (primary key) read.
 */
export async function checkRateLimit(key: string): Promise<RateLimitResult> {
  const supabase = createAdminClient({ purpose: "rate-limit" });
  const { data, error } = await supabase
    .from("rate_limits")
    .select("blocked_until")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const blockedUntil = data?.blocked_until
    ? new Date(data.blocked_until).getTime()
    : null;
  const now = Date.now();

  if (blockedUntil && blockedUntil > now) {
    return {
      allowed: false,
      blockedUntil: new Date(blockedUntil),
      secondsRemaining: Math.ceil((blockedUntil - now) / MS_PER_SECOND),
    };
  }

  return {
    allowed: true,
    blockedUntil: null,
    secondsRemaining: 0,
  };
}

/**
 * Records a failed attempt for the given key and calculates lockout backoff if necessary.
 *
 * Backoff rules (enforced atomically in Postgres by the
 * rate_limit_record_failure() function — see its migration for details):
 * - Attempts 1-4: Allowed, no lockout.
 * - Attempt 5: Locked out for 30 seconds.
 * - Attempts 6+: Locked out with exponential doubling (30s * 2^(attempts-5)) up to a maximum of 15 minutes (900s).
 *
 * The increment-then-check is done as a single `INSERT ... ON CONFLICT DO
 * UPDATE` statement inside that function, so concurrent failures for the
 * same key (whether from one instance or many) never lose an increment.
 */
export async function recordFailure(key: string): Promise<void> {
  const supabase = createAdminClient({ purpose: "rate-limit" });
  const { error } = await supabase.rpc("rate_limit_record_failure", {
    p_key: key,
  });

  if (error) {
    throw error;
  }
}

/**
 * Resets the rate limit records for a given key on successful attempt.
 */
export async function recordSuccess(key: string): Promise<void> {
  const supabase = createAdminClient({ purpose: "rate-limit" });
  const { error } = await supabase.from("rate_limits").delete().eq("key", key);

  if (error) {
    throw error;
  }
}

/**
 * Helper to clear all rate limits (useful in tests).
 */
export async function clearAllRateLimits(): Promise<void> {
  const supabase = createAdminClient({ purpose: "rate-limit" });
  const { error } = await supabase
    .from("rate_limits")
    .delete()
    .not("key", "is", null);

  if (error) {
    throw error;
  }
}

/**
 * Expands an IPv6 literal (which may use "::" to elide runs of zero groups)
 * into its 8 full 16-bit hex groups. Does not handle the dotted-decimal
 * IPv4-mapped form (e.g. "::ffff:192.0.2.1") -- callers should catch and
 * fall back to the unmodified address for those.
 */
function expandIpv6Groups(ip: string): string[] {
  // Strip a zone id (e.g. "fe80::1%eth0") -- irrelevant to bucketing.
  const withoutZone = ip.split("%")[0] ?? ip;
  const halves = withoutZone.split("::");
  if (halves.length > 2) {
    throw new Error("malformed IPv6 literal: multiple '::'");
  }
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) {
    throw new Error("malformed IPv6 literal: too many groups");
  }
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) {
    throw new Error("malformed IPv6 literal: non-hex group");
  }
  return groups;
}

/**
 * Issue #517: buckets an IPv6 address to its /64 network prefix so an
 * attacker cannot dodge an IP-keyed rate limit by rotating through the
 * effectively unlimited host addresses within a single /64 they control
 * (the size a residential ISP or cloud provider typically hands out as one
 * allocation). IPv4 addresses are not bucketed -- a /32 is already a single
 * host, and the equivalent-sized ISP allocations are much smaller.
 *
 * Falls back to the address unchanged if it cannot be parsed as plain
 * hex-group IPv6 (e.g. the dotted-decimal IPv4-mapped form) -- normalization
 * is a defense-in-depth improvement here, not something later validation
 * depends on, so a rare unparseable-but-valid literal degrades gracefully
 * instead of making the caller treat a real client IP as missing.
 */
export function bucketIpv6ToSlash64(ip: string): string {
  try {
    const groups = expandIpv6Groups(ip);
    return `${groups.slice(0, 4).join(":")}::`;
  } catch {
    return ip;
  }
}

/**
 * Validates `candidate` as an IPv4 or IPv6 literal and normalizes it
 * (IPv6 -> /64 bucket). Returns null for anything empty, malformed, or
 * otherwise not a bare IP literal -- callers treat null exactly like a
 * missing header and fall through to the next candidate source.
 */
function normalizeIpCandidate(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  if (!trimmed) return null;
  const version = isIP(trimmed);
  if (version === 4) return trimmed;
  if (version === 6) return bucketIpv6ToSlash64(trimmed);
  return null;
}

/**
 * Resolves the client IP address from the request headers.
 *
 * Issue #517: X-Forwarded-For is appended to by each proxy hop, never
 * replaced -- a client can freely set its own leftmost entries, so only the
 * entry `trustedProxyHops` positions in from the *right* is actually ours to
 * trust (everything further left could be attacker-supplied). Rotating that
 * leftmost value on every request used to reset this function's return
 * value entirely, defeating IP-keyed brute-force lockouts.
 *
 * Preferred over walking X-Forwarded-For at all: a platform-injected header
 * (default "x-vercel-forwarded-for" -- see CLIENT_IP_HEADER in
 * lib/runtime-config.ts) that the platform itself sets/overwrites on every
 * request, so it cannot carry a client-supplied value in the first place.
 */
export async function getClientIp(): Promise<string> {
  const headersList = await headers();
  const { trustedProxyHops, header: clientIpHeader } = getRuntimeConfig().clientIp;

  const platformIp = normalizeIpCandidate(headersList.get(clientIpHeader));
  if (platformIp) return platformIp;

  const forwardedFor = headersList.get("x-forwarded-for");
  if (forwardedFor) {
    const entries = forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length > 0) {
      // Clamp: with fewer entries than trusted hops, the leftmost (only
      // fully-untrusted-in-theory) entry is in practice the one our own
      // reverse proxy appended, since no proxy in between had a chance to.
      const trustedIndex = Math.max(0, entries.length - trustedProxyHops);
      const candidate = normalizeIpCandidate(entries[trustedIndex]);
      if (candidate) return candidate;
    }
  }

  const realIp = normalizeIpCandidate(headersList.get("x-real-ip"));
  if (realIp) return realIp;

  return FALLBACK_CLIENT_IP;
}
