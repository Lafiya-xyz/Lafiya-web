import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mock supabase admin client ----
const mockRpc = vi.fn();
const mockDelete = vi.fn();
const mockEq = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mockRpc,
    from: () => ({
      delete: () => ({
        eq: mockEq,
      }),
    }),
  }),
}));

import {
  checkAndIncrementFrequency,
  clearFrequencyLimit,
} from "./frequency-limit";

// Helper to build the RPC response the Postgres function returns.
function rpcResult(allowed: boolean, count: number, retryAfterSeconds: number) {
  return {
    data: { allowed, count, retry_after_seconds: retryAfterSeconds },
    error: null,
  };
}

describe("checkAndIncrementFrequency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a request comfortably under the limit", async () => {
    // 2 out of 5 allowed — well below the cap.
    mockRpc.mockReturnValue({
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
    mockRpc.mockReturnValue({
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
    mockRpc.mockReturnValue({
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
    mockRpc.mockReturnValue({
      single: () => Promise.resolve(rpcResult(false, 10, 37)),
    });

    const result = await checkAndIncrementFrequency("k", 5, 60);

    expect(result.retryAfterSeconds).toBe(37);
  });

  it("allows again once the window resets (counter back to 1)", async () => {
    // Simulate window expiry: the DB resets the row and returns count=1.
    mockRpc.mockReturnValue({
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
    mockRpc.mockReturnValue({
      single: () => Promise.resolve(rpcResult(true, 1, 0)),
    });

    await checkAndIncrementFrequency("myKey", 10, 120);

    expect(mockRpc).toHaveBeenCalledWith(
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
    mockRpc.mockReturnValue({
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
    mockEq.mockResolvedValue({ error: null });
  });

  it("deletes the row for the given key without error", async () => {
    await expect(clearFrequencyLimit("user:abc:photo-upload")).resolves.toBeUndefined();
    expect(mockEq).toHaveBeenCalledWith("key", "user:abc:photo-upload");
  });

  it("throws when the delete returns an error", async () => {
    const dbError = { message: "permission denied", code: "42501" };
    mockEq.mockResolvedValue({ error: dbError });

    await expect(clearFrequencyLimit("k")).rejects.toMatchObject({
      message: "permission denied",
    });
  });
});
