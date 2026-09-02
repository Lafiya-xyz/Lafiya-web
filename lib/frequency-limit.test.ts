import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcSingleMock = vi.fn();
const rpcMock = vi.fn();
const eqMock = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: rpcMock,
    from: () => ({
      delete: () => ({
        eq: eqMock,
      }),
    }),
  }),
}));

import {
  checkAndIncrementFrequency,
  clearFrequencyLimit,
  sanitizeFrequencyLimitResult,
} from "./frequency-limit";

// Helper to build the RPC response the Postgres function returns.
function rpcResult(allowed: boolean, count: number, retryAfterSeconds: number) {
  return {
    data: { allowed, count, retry_after_seconds: retryAfterSeconds },
    error: null,
  };
}

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

describe("checkAndIncrementFrequency / clock resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Restore the default single-shot-per-call implementation explicitly —
    // a preceding describe block below overrides rpcMock's return value with
    // mockReturnValue, which otherwise persists across describe blocks.
    rpcMock.mockImplementation(() => ({ single: rpcSingleMock }));
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

describe("checkAndIncrementFrequency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a request comfortably under the limit", async () => {
    // 2 out of 5 allowed — well below the cap.
    rpcMock.mockReturnValue({
      single: () => Promise.resolve(rpcResult(true, 2, 0)),
    });

    const result = await checkAndIncrementFrequency(
      "user:abc:photo-upload",
      5,
      60,
    );

    expect(result.allowed).toBe(true);
    expect(result.count).toBe(2);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("allows a request that hits the limit exactly (at-limit request is permitted)", async () => {
    // The RPC atomically increments then checks. Reaching count===maxCount
    // is the boundary: by design the nth request is still allowed (the
    // window started with 0; you're allowed maxCount total requests).
    rpcMock.mockReturnValue({
      single: () => Promise.resolve(rpcResult(true, 5, 0)),
    });

    const result = await checkAndIncrementFrequency(
      "user:abc:photo-upload",
      5,
      60,
    );

    expect(result.allowed).toBe(true);
    expect(result.count).toBe(5);
  });

  it("rejects a request that exceeds the limit", async () => {
    // count > maxCount — window not yet expired.
    rpcMock.mockReturnValue({
      single: () => Promise.resolve(rpcResult(false, 6, 42)),
    });

    const result = await checkAndIncrementFrequency(
      "user:abc:photo-upload",
      5,
      60,
    );

    expect(result.allowed).toBe(false);
    expect(result.count).toBe(6);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("maps retryAfterSeconds from the snake_case RPC field", async () => {
    rpcMock.mockReturnValue({
      single: () => Promise.resolve(rpcResult(false, 10, 37)),
    });

    const result = await checkAndIncrementFrequency("k", 5, 60);

    expect(result.retryAfterSeconds).toBe(37);
  });

  it("allows again once the window resets (counter back to 1)", async () => {
    // Simulate window expiry: the DB resets the row and returns count=1.
    rpcMock.mockReturnValue({
      single: () => Promise.resolve(rpcResult(true, 1, 0)),
    });

    const result = await checkAndIncrementFrequency(
      "user:abc:photo-upload",
      5,
      60,
    );

    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("passes p_key, p_max_count, and p_window_seconds to the RPC", async () => {
    rpcMock.mockReturnValue({
      single: () => Promise.resolve(rpcResult(true, 1, 0)),
    });

    await checkAndIncrementFrequency("myKey", 10, 120);

    expect(rpcMock).toHaveBeenCalledWith(
      "frequency_limit_check_and_increment",
      {
        p_key: "myKey",
        p_max_count: 10,
        p_window_seconds: 120,
      },
    );
  });

  it("throws when the RPC returns an error", async () => {
    const dbError = { message: "connection refused", code: "08006" };
    rpcMock.mockReturnValue({
      single: () => Promise.resolve({ data: null, error: dbError }),
    });

    await expect(
      checkAndIncrementFrequency("k", 5, 60),
    ).rejects.toMatchObject({ message: "connection refused" });
  });
});

describe("clearFrequencyLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eqMock.mockResolvedValue({ error: null });
  });

  it("deletes the row for the given key without error", async () => {
    await expect(clearFrequencyLimit("user:abc:photo-upload")).resolves.toBeUndefined();
    expect(eqMock).toHaveBeenCalledWith("key", "user:abc:photo-upload");
  });

  it("throws when the delete returns an error", async () => {
    const dbError = { message: "permission denied", code: "42501" };
    eqMock.mockResolvedValue({ error: dbError });

    await expect(clearFrequencyLimit("k")).rejects.toMatchObject({
      message: "permission denied",
    });
  });
});
