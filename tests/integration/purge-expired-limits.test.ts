import { afterEach, describe, expect, it } from "vitest";

import { adminClient } from "./helpers/testUser";

/**
 * Issue #514: garbage collection for rate_limits and frequency_limits.
 *
 * These tests write rows directly via the service-role client (bypassing
 * RLS, same as tests/integration/rate-limit.test.ts) so each row's
 * updated_at/window_start can be backdated to simulate "long idle" without
 * waiting for real time to pass -- the app's own lib/rate-limit.ts and
 * lib/frequency-limit.ts always write now(), so there is no other way to
 * exercise the boundary from outside the database.
 */

function testKey(label: string): string {
  return `test:${label}:${crypto.randomUUID()}`;
}

const cleanupRateLimitKeys = new Set<string>();
const cleanupFrequencyLimitKeys = new Set<string>();

function trackedRateLimitKey(label: string): string {
  const key = testKey(label);
  cleanupRateLimitKeys.add(key);
  return key;
}

function trackedFrequencyLimitKey(label: string): string {
  const key = testKey(label);
  cleanupFrequencyLimitKeys.add(key);
  return key;
}

afterEach(async () => {
  await Promise.all([
    ...Array.from(cleanupRateLimitKeys).map((key) =>
      adminClient.from("rate_limits").delete().eq("key", key),
    ),
    ...Array.from(cleanupFrequencyLimitKeys).map((key) =>
      adminClient.from("frequency_limits").delete().eq("key", key),
    ),
  ]);
  cleanupRateLimitKeys.clear();
  cleanupFrequencyLimitKeys.clear();
});

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function purge(): Promise<{
  rate_limits_purged: number;
  frequency_limits_purged: number;
}> {
  const { data, error } = await adminClient
    .rpc("purge_expired_limits", { p_batch_size: 1000 })
    .single();
  if (error) throw error;
  return data;
}

describe("purge_expired_limits (#514)", () => {
  describe("rate_limits", () => {
    it("removes a row that is idle and not currently locked out", async () => {
      const key = trackedRateLimitKey("idle-unlocked");
      const { error } = await adminClient.from("rate_limits").insert({
        key,
        attempts: 3,
        blocked_until: null,
        updated_at: hoursAgo(2),
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("rate_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).toBeNull();
    });

    it("never removes a row that is still actively locked out, no matter how idle", async () => {
      const key = trackedRateLimitKey("stale-but-locked");
      const { error } = await adminClient.from("rate_limits").insert({
        key,
        attempts: 6,
        blocked_until: hoursFromNow(1),
        updated_at: hoursAgo(2),
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("rate_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).not.toBeNull();
    });

    it("does not remove a row that was updated recently, even if unlocked", async () => {
      const key = trackedRateLimitKey("recent-unlocked");
      const { error } = await adminClient.from("rate_limits").insert({
        key,
        attempts: 2,
        blocked_until: null,
        updated_at: new Date().toISOString(),
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("rate_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).not.toBeNull();
    });

    it("removes a row whose lockout expired long ago", async () => {
      const key = trackedRateLimitKey("expired-lockout");
      const { error } = await adminClient.from("rate_limits").insert({
        key,
        attempts: 6,
        blocked_until: hoursAgo(2),
        updated_at: hoursAgo(2),
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("rate_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).toBeNull();
    });
  });

  describe("frequency_limits", () => {
    it("removes a row whose window closed long ago", async () => {
      const key = trackedFrequencyLimitKey("closed-window");
      const { error } = await adminClient.from("frequency_limits").insert({
        key,
        window_start: hoursAgo(2),
        count: 5,
        window_seconds: 60,
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("frequency_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).toBeNull();
    });

    it("never removes a row whose window is still open", async () => {
      const key = trackedFrequencyLimitKey("open-window");
      const { error } = await adminClient.from("frequency_limits").insert({
        key,
        window_start: new Date().toISOString(),
        count: 3,
        window_seconds: 3600,
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("frequency_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).not.toBeNull();
    });

    it("respects each row's own window_seconds rather than a fixed guess", async () => {
      // Opened 90 minutes ago with a 2-hour window -- still open despite
      // being "old" by the rate_limits table's 1-hour idle standard.
      const key = trackedFrequencyLimitKey("long-window-still-open");
      const { error } = await adminClient.from("frequency_limits").insert({
        key,
        window_start: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
        count: 10,
        window_seconds: 2 * 60 * 60,
      });
      expect(error).toBeNull();

      await purge();

      const { data } = await adminClient
        .from("frequency_limits")
        .select("key")
        .eq("key", key)
        .maybeSingle();
      expect(data).not.toBeNull();
    });
  });

  it("respects p_batch_size, purging at most that many rows per table per call", async () => {
    const keys = Array.from({ length: 5 }, () =>
      trackedRateLimitKey("batch-limited"),
    );
    for (const key of keys) {
      const { error } = await adminClient.from("rate_limits").insert({
        key,
        attempts: 1,
        blocked_until: null,
        updated_at: hoursAgo(2),
      });
      expect(error).toBeNull();
    }

    const { data, error } = await adminClient
      .rpc("purge_expired_limits", { p_batch_size: 2 })
      .single();
    expect(error).toBeNull();
    expect(data!.rate_limits_purged).toBe(2);

    const { data: remaining } = await adminClient
      .from("rate_limits")
      .select("key")
      .in("key", keys);
    expect(remaining).toHaveLength(3);
  });
});
