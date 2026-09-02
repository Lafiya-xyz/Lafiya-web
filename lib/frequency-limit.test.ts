import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkAndIncrementFrequency,
  sanitizeFrequencyLimitResult,
} from "./frequency-limit";

/**
 * In-memory stand-in for the `frequency_limit_check_and_increment` Postgres
 * function, deliberately implemented with a naive fixed-window algorithm
 * keyed off wall-clock time (the same class of implementation the real
 * windowing logic could regress into). This lets us simulate what happens
 * to a caller of checkAndIncrementFrequency when the underlying clock used
 * for windowing jumps backward mid-window.
 */
function createNaiveWindow(maxCount: number, windowSeconds: number) {
  let windowStartMs: number | null = null;
  let count = 0;

  return function tick(nowMs: number) {
    if (windowStartMs === null || nowMs - windowStartMs >= windowSeconds * 1000) {
      windowStartMs = nowMs;
      count = 0;
    }
    count += 1;
    const elapsedSeconds = (nowMs - windowStartMs) / 1000;
    const retryAfterSeconds = Math.max(
      0,
      Math.round(windowSeconds - elapsedSeconds),
    );
    return {
      allowed: count <= maxCount,
      count,
      retry_after_seconds: count <= maxCount ? 0 : retryAfterSeconds,
    };
  };
}

const rpcSingleMock = vi.fn();
const rpcMock = vi.fn(() => ({ single: rpcSingleMock }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: rpcMock }),
}));

describe("checkAndIncrementFrequency / clock resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcSingleMock.mockReset();
    rpcMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not allow unlimited requests when the clock jumps backward mid-window", async () => {
    const maxCount = 3;
    const windowSeconds = 60;
    const tick = createNaiveWindow(maxCount, windowSeconds);

    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    rpcSingleMock.mockImplementationOnce(async () => ({
      data: tick(Date.now()),
      error: null,
    }));
    const first = await checkAndIncrementFrequency("user:1", maxCount, windowSeconds);
    expect(first.allowed).toBe(true);

    // Fill the window.
    for (let i = 0; i < maxCount - 1; i++) {
      rpcSingleMock.mockImplementationOnce(async () => ({
        data: tick(Date.now()),
        error: null,
      }));
      await checkAndIncrementFrequency("user:1", maxCount, windowSeconds);
    }

    // The window is now full. Jump the clock backward by 10 minutes -- an
    // NTP correction or container clock skew mid-window -- and request
    // again. A naive window implementation would treat `nowMs` as "long
    // before windowStartMs", fail the `>= windowSeconds * 1000` check, and
    // keep accumulating against the same window indefinitely, or could
    // produce a negative retry-after that reads as "already expired".
    vi.setSystemTime(new Date("2026-01-01T23:50:00.000Z"));

    const resultCount = tick(Date.now());
    rpcSingleMock.mockImplementationOnce(async () => ({
      data: resultCount,
      error: null,
    }));
    const afterJump = await checkAndIncrementFrequency(
      "user:1",
      maxCount,
      windowSeconds,
    );

    expect(afterJump.allowed).toBe(false);
  });

  it("sanitizeFrequencyLimitResult fails closed on a negative retry-after", () => {
    const sanitized = sanitizeFrequencyLimitResult({
      allowed: true,
      count: 50,
      retryAfterSeconds: -30,
    });

    expect(sanitized.allowed).toBe(false);
    expect(sanitized.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("sanitizeFrequencyLimitResult passes through a consistent allowed result", () => {
    const sanitized = sanitizeFrequencyLimitResult({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
    });

    expect(sanitized).toEqual({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
    });
  });
});
