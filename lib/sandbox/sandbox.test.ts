import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stellar/attestation", () => ({ getAttestation: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    blockedUntil: null,
    secondsRemaining: 0,
  })),
  recordFailure: vi.fn(async () => {}),
  getClientIp: vi.fn(async () => "203.0.113.1"),
}));
vi.mock("@/lib/logging/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

import { GET } from "@/app/api/attestation/[recordHash]/route";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAttestation } from "@/lib/stellar/attestation";
import {
  SANDBOX_FIXTURES,
  SANDBOX_RATE_LIMIT,
  resetSandboxRateLimits,
} from ".";

const SANDBOX_KEY = "lfy_sbx_test_key_1";
const PRODUCTION_HASH = "b".repeat(64);
const VERIFIED_FIXTURE = "1".repeat(64);

function call(recordHash: string, token?: string) {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return GET(
    new Request(`http://localhost/api/attestation/${recordHash}`, { headers }),
    {
      params: Promise.resolve({ recordHash }),
    },
  );
}

describe("partner sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSandboxRateLimits();
    process.env.LAFIYA_SANDBOX_API_KEYS = SANDBOX_KEY;
  });

  it("serves every lifecycle fixture, marked as sandbox", async () => {
    for (const [hash, fixture] of SANDBOX_FIXTURES) {
      const res = await call(hash, SANDBOX_KEY);
      const body = await res.json();
      expect(res.headers.get("X-Lafiya-Sandbox")).toBe("true");
      expect(body).toMatchObject({
        sandbox: true,
        state: fixture.state,
        verified: fixture.verified,
      });
      expect(body.simulatedWebhook).toMatchObject({
        type: `attestation.${fixture.state}`,
      });
    }
  });

  it("a sandbox key cannot read production data", async () => {
    vi.mocked(getAttestation).mockResolvedValue({
      value: { recordHash: PRODUCTION_HASH },
    } as never);
    const body = await (await call(PRODUCTION_HASH, SANDBOX_KEY)).json();
    expect(body).toMatchObject({
      sandbox: true,
      verified: false,
      attestation: null,
    });
    expect(getAttestation).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("production callers never receive sandbox fixtures", async () => {
    vi.mocked(getAttestation).mockResolvedValue(null as never);
    const res = await call(VERIFIED_FIXTURE);
    const body = await res.json();
    expect(getAttestation).toHaveBeenCalledWith(VERIFIED_FIXTURE);
    expect(body.sandbox).toBeUndefined();
    expect(body.verified).toBe(false);
    expect(res.headers.get("X-Lafiya-Sandbox")).toBeNull();
  });

  it("rejects an unknown sandbox-prefixed key instead of falling through", async () => {
    const res = await call(VERIFIED_FIXTURE, "lfy_sbx_unknown");
    expect(res.status).toBe(401);
    expect(getAttestation).not.toHaveBeenCalled();
  });

  it("applies a separate sandbox rate limit", async () => {
    for (let i = 0; i < SANDBOX_RATE_LIMIT.limit; i++) {
      expect((await call(VERIFIED_FIXTURE, SANDBOX_KEY)).status).toBe(200);
    }
    const res = await call(VERIFIED_FIXTURE, SANDBOX_KEY);
    expect(res.status).toBe(429);
    expect((await res.json()).sandbox).toBe(true);
  });
});
