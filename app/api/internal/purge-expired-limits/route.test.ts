import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockRpc, mockLogInfo, mockLogError, serverEnv } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
  serverEnv: { PURGE_LIMITS_CRON_SECRET: "test-cron-secret" as string | undefined },
}));

vi.mock("@/lib/env-server", () => ({ serverEnv }));
vi.mock("@/lib/logging/logger", () => ({
  logInfo: mockLogInfo,
  logError: mockLogError,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: mockRpc,
  }),
}));

import { POST } from "./route";

function authorizedRequest(secret = "test-cron-secret") {
  return new Request("http://localhost:3000/api/internal/purge-expired-limits", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function rpcResult(rate_limits_purged: number, frequency_limits_purged: number) {
  return {
    single: () =>
      Promise.resolve({
        data: { rate_limits_purged, frequency_limits_purged },
        error: null,
      }),
  };
}

describe("POST /api/internal/purge-expired-limits (#514)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverEnv.PURGE_LIMITS_CRON_SECRET = "test-cron-secret";
  });

  it("returns 503 when the cron secret is not configured", async () => {
    serverEnv.PURGE_LIMITS_CRON_SECRET = undefined;

    const res = await POST(authorizedRequest());

    expect(res.status).toBe(503);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns 401 for a missing or wrong bearer token", async () => {
    const resMissing = await POST(
      new Request("http://localhost:3000/api/internal/purge-expired-limits", {
        method: "POST",
      }),
    );
    expect(resMissing.status).toBe(401);

    const resWrong = await POST(authorizedRequest("wrong-secret"));
    expect(resWrong.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("stops looping as soon as a call reports nothing left to purge", async () => {
    mockRpc
      .mockReturnValueOnce(rpcResult(3, 5))
      .mockReturnValueOnce(rpcResult(0, 0));

    const res = await POST(authorizedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ rateLimitsPurged: 3, frequencyLimitsPurged: 5 });
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc).toHaveBeenCalledWith("purge_expired_limits", {
      p_batch_size: expect.any(Number),
    });
  });

  it("loops across multiple batches until a call reports zero purged", async () => {
    mockRpc
      .mockReturnValueOnce(rpcResult(1000, 1000))
      .mockReturnValueOnce(rpcResult(1000, 400))
      .mockReturnValueOnce(rpcResult(0, 0));

    const res = await POST(authorizedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ rateLimitsPurged: 2000, frequencyLimitsPurged: 1400 });
    expect(mockRpc).toHaveBeenCalledTimes(3);
  });

  it("caps the number of batches per request even if the backlog never drains", async () => {
    mockRpc.mockReturnValue(rpcResult(1000, 1000));

    const res = await POST(authorizedRequest());

    expect(res.status).toBe(200);
    // Bounded, not infinite -- the route must return control to the caller
    // (and to the next scheduled invocation) rather than looping forever.
    expect(mockRpc.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("returns 500 and logs when the RPC call errors", async () => {
    mockRpc.mockReturnValue({
      single: () =>
        Promise.resolve({ data: null, error: { message: "db unavailable" } }),
    });

    const res = await POST(authorizedRequest());

    expect(res.status).toBe(500);
    expect(mockLogError).toHaveBeenCalled();
  });
});
