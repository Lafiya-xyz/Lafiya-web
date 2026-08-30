import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/stellar/attestation", () => ({
  getAttestation: vi.fn(),
  DEMO_VERIFIED_RECORD_HASH: "a".repeat(64),
}));

const { mockHeaders, mockLogError, mockLogInfo, rateLimitAttempts } =
  vi.hoisted(() => ({
    mockHeaders: vi.fn(),
    mockLogError: vi.fn(),
    mockLogInfo: vi.fn(),
    rateLimitAttempts: new Map<string, number>(),
  }));
vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async (key: string) => {
    const attempts = rateLimitAttempts.get(key) ?? 0;
    return {
      allowed: attempts < 5,
      blockedUntil: attempts < 5 ? null : new Date(Date.now() + 30_000),
      secondsRemaining: attempts < 5 ? 0 : 30,
    };
  }),
  recordFailure: vi.fn(async (key: string) => {
    rateLimitAttempts.set(key, (rateLimitAttempts.get(key) ?? 0) + 1);
  }),
  clearAllRateLimits: vi.fn(async () => {
    rateLimitAttempts.clear();
  }),
  getClientIp: vi.fn(async () => {
    const headers = await mockHeaders();
    const forwardedFor = headers.get("x-forwarded-for");
    return forwardedFor?.split(",")[0]?.trim() || "127.0.0.1";
  }),
}));
vi.mock("@/lib/logging/logger", () => ({
  logError: mockLogError,
  logInfo: mockLogInfo,
}));

import { getAttestation } from "@/lib/stellar/attestation";
import {
  checkRateLimit,
  clearAllRateLimits,
  getClientIp,
  recordFailure,
} from "@/lib/rate-limit";
import { GET } from "./route";

const VALID_HASH = "b".repeat(64);
const MOCK_ATTESTATION = {
  recordHash: VALID_HASH,
  attester: "GDEMOATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  timestamp: 1735689600,
};

describe("Attestation Route Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllRateLimits();
    mockHeaders.mockResolvedValue({
      get: (name: string) =>
        name === "x-forwarded-for" ? "203.0.113.1" : null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns verified true and attestation object for a known valid hash", async () => {
    vi.mocked(getAttestation).mockResolvedValue(MOCK_ATTESTATION);

    const request = new Request(
      `http://localhost/api/attestation/${VALID_HASH}`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ recordHash: VALID_HASH }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      verified: true,
      attestation: MOCK_ATTESTATION,
    });
    expect(mockLogInfo).toHaveBeenLastCalledWith(
      "Attestation lookup completed",
      {
        routeClass: "attestation_lookup",
        outcome: "verified",
        latencyBucket: expect.any(String),
      },
    );
  });

  it("returns verified false and null attestation for an unknown valid hash", async () => {
    vi.mocked(getAttestation).mockResolvedValue(null);

    const request = new Request(
      `http://localhost/api/attestation/${VALID_HASH}`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ recordHash: VALID_HASH }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      verified: false,
      attestation: null,
    });
    expect(mockLogInfo).toHaveBeenLastCalledWith(
      "Attestation lookup completed",
      {
        routeClass: "attestation_lookup",
        outcome: "not_found",
        latencyBucket: expect.any(String),
      },
    );
  });

  it("accepts uppercase hex characters due to case-insensitive pattern", async () => {
    const uppercaseHash = "A".repeat(64);
    vi.mocked(getAttestation).mockResolvedValue(null);

    const request = new Request(
      `http://localhost/api/attestation/${uppercaseHash}`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ recordHash: uppercaseHash }),
    });

    expect(response.status).toBe(200);
    expect(getAttestation).toHaveBeenCalledWith(uppercaseHash);
  });

  describe("malformed hash and regex boundary cases (400 responses)", () => {
    const errorMsg = "recordHash must be a 64-character hex SHA-256 digest";

    it("rejects hash that is too short (63 characters)", async () => {
      const shortHash = "a".repeat(63);
      const request = new Request(
        `http://localhost/api/attestation/${shortHash}`,
      );
      const response = await GET(request, {
        params: Promise.resolve({ recordHash: shortHash }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toEqual({ error: errorMsg });
      expect(getAttestation).not.toHaveBeenCalled();
      expect(mockLogInfo).toHaveBeenLastCalledWith(
        "Attestation lookup completed",
        {
          routeClass: "attestation_lookup",
          outcome: "invalid_request",
          latencyBucket: expect.any(String),
        },
      );
    });

    it("rejects hash that is too long (65 characters)", async () => {
      const longHash = "a".repeat(65);
      const request = new Request(
        `http://localhost/api/attestation/${longHash}`,
      );
      const response = await GET(request, {
        params: Promise.resolve({ recordHash: longHash }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toEqual({ error: errorMsg });
      expect(getAttestation).not.toHaveBeenCalled();
    });

    it("rejects hash with non-hex characters (e.g. 'g')", async () => {
      const nonHexHash = "g" + "a".repeat(63);
      const request = new Request(
        `http://localhost/api/attestation/${nonHexHash}`,
      );
      const response = await GET(request, {
        params: Promise.resolve({ recordHash: nonHexHash }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toEqual({ error: errorMsg });
      expect(getAttestation).not.toHaveBeenCalled();
    });

    it("rejects empty or missing hash", async () => {
      const request = new Request(`http://localhost/api/attestation/`);
      const response = await GET(request, {
        params: Promise.resolve({ recordHash: "" }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data).toEqual({ error: errorMsg });
      expect(getAttestation).not.toHaveBeenCalled();
    });
  });

  it("ensures response shape stability with no unexpected internal fields", async () => {
    vi.mocked(getAttestation).mockResolvedValue(MOCK_ATTESTATION);

    const request = new Request(
      `http://localhost/api/attestation/${VALID_HASH}`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ recordHash: VALID_HASH }),
    });

    const data = await response.json();
    const keys = Object.keys(data).sort();
    expect(keys).toEqual(["attestation", "verified"]);
  });

  describe("rate limiting (defense-in-depth)", () => {
    it("blocks with 429 after 5 lookups from the same IP", async () => {
      vi.mocked(getAttestation).mockResolvedValue(null);

      for (let i = 0; i < 5; i++) {
        const response = await GET(
          new Request(`http://localhost/api/attestation/${VALID_HASH}`),
          { params: Promise.resolve({ recordHash: VALID_HASH }) },
        );
        expect(response.status).toBe(200);
      }

      const blocked = await GET(
        new Request(`http://localhost/api/attestation/${VALID_HASH}`),
        { params: Promise.resolve({ recordHash: VALID_HASH }) },
      );

      expect(blocked.status).toBe(429);
      const data = await blocked.json();
      expect(data).toMatchObject({ error: expect.any(String) });
      expect(data.secondsRemaining).toBeGreaterThan(0);
      expect(mockLogInfo).toHaveBeenLastCalledWith(
        "Attestation lookup completed",
        {
          routeClass: "attestation_lookup",
          outcome: "rate_limited",
          latencyBucket: expect.any(String),
        },
      );
    });

    it("does not consult getAttestation once blocked", async () => {
      vi.mocked(getAttestation).mockResolvedValue(null);

      for (let i = 0; i < 5; i++) {
        await GET(
          new Request(`http://localhost/api/attestation/${VALID_HASH}`),
          {
            params: Promise.resolve({ recordHash: VALID_HASH }),
          },
        );
      }
      vi.mocked(getAttestation).mockClear();

      await GET(new Request(`http://localhost/api/attestation/${VALID_HASH}`), {
        params: Promise.resolve({ recordHash: VALID_HASH }),
      });

      expect(getAttestation).not.toHaveBeenCalled();
    });

    it("counts a lookup as an attempt even when it resolves 'verified: true' — a lucky guess must not reset the counter", async () => {
      vi.mocked(getAttestation).mockResolvedValue(MOCK_ATTESTATION);

      for (let i = 0; i < 5; i++) {
        await GET(
          new Request(`http://localhost/api/attestation/${VALID_HASH}`),
          {
            params: Promise.resolve({ recordHash: VALID_HASH }),
          },
        );
      }

      const blocked = await GET(
        new Request(`http://localhost/api/attestation/${VALID_HASH}`),
        { params: Promise.resolve({ recordHash: VALID_HASH }) },
      );
      expect(blocked.status).toBe(429);
    });

    it("tracks limits independently per client IP", async () => {
      vi.mocked(getAttestation).mockResolvedValue(null);

      for (let i = 0; i < 5; i++) {
        await GET(
          new Request(`http://localhost/api/attestation/${VALID_HASH}`),
          {
            params: Promise.resolve({ recordHash: VALID_HASH }),
          },
        );
      }

      mockHeaders.mockResolvedValue({
        get: (name: string) =>
          name === "x-forwarded-for" ? "198.51.100.7" : null,
      });

      const fromOtherIp = await GET(
        new Request(`http://localhost/api/attestation/${VALID_HASH}`),
        { params: Promise.resolve({ recordHash: VALID_HASH }) },
      );
      expect(fromOtherIp.status).toBe(200);
    });

    it("400 responses for malformed hashes are not rate-limited attempts", async () => {
      const shortHash = "a".repeat(63);

      for (let i = 0; i < 10; i++) {
        const response = await GET(
          new Request(`http://localhost/api/attestation/${shortHash}`),
          { params: Promise.resolve({ recordHash: shortHash }) },
        );
        expect(response.status).toBe(400);
      }
    });
  });

  it("logs a bounded error outcome without the record hash", async () => {
    vi.mocked(getAttestation).mockRejectedValue(
      new Error(
        `provider failed for ${VALID_HASH} at 198.51.100.7 token opaque-secret health O+`,
      ),
    );

    const response = await GET(
      new Request(`http://localhost/api/attestation/${VALID_HASH}`),
      { params: Promise.resolve({ recordHash: VALID_HASH }) },
    );

    expect(response.status).toBe(500);
    expect(mockLogError).toHaveBeenCalledWith(
      "Attestation lookup failed",
      expect.objectContaining({ message: "ATTESTATION_LOOKUP_FAILED" }),
      {
        routeClass: "attestation_lookup",
        outcome: "error",
        latencyBucket: expect.any(String),
      },
    );
    expect(mockLogError.mock.calls[0][2]).not.toHaveProperty("recordHash");
    expect((mockLogError.mock.calls[0][1] as Error).message).not.toContain(
      VALID_HASH,
    );
  });

  it.each(["client_ip", "rate_limit", "attempt_recording"] as const)(
    "does not forward %s dependency error details to telemetry",
    async (failurePoint) => {
      const sensitiveError = new Error(
        "failure for 198.51.100.7 token opaque-secret health O+",
      );
      if (failurePoint === "client_ip") {
        vi.mocked(getClientIp).mockRejectedValueOnce(sensitiveError);
      } else if (failurePoint === "rate_limit") {
        vi.mocked(checkRateLimit).mockRejectedValueOnce(sensitiveError);
      } else {
        vi.mocked(recordFailure).mockRejectedValueOnce(sensitiveError);
      }

      const response = await GET(
        new Request(`http://localhost/api/attestation/${VALID_HASH}`),
        { params: Promise.resolve({ recordHash: VALID_HASH }) },
      );

      expect(response.status).toBe(500);
      expect(getAttestation).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalledWith(
        "Attestation lookup failed",
        expect.objectContaining({ message: "ATTESTATION_LOOKUP_FAILED" }),
        {
          routeClass: "attestation_lookup",
          outcome: "error",
          latencyBucket: expect.any(String),
        },
      );
      const telemetryInput = {
        error: (mockLogError.mock.calls[0][1] as Error).message,
        context: mockLogError.mock.calls[0][2],
      };
      expect(JSON.stringify(telemetryInput)).not.toContain("198.51.100.7");
      expect(JSON.stringify(telemetryInput)).not.toContain("opaque-secret");
      expect(JSON.stringify(telemetryInput)).not.toContain("O+");
    },
  );

  it.each([
    [99, "under_100_ms"],
    [100, "100_to_499_ms"],
    [500, "500_to_1999_ms"],
    [2_000, "2000_ms_or_more"],
  ])(
    "buckets %i ms without logging raw duration",
    async (elapsedMs, bucket) => {
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(1_000 + elapsedMs);
      vi.mocked(getAttestation).mockResolvedValue(null);

      await GET(new Request(`http://localhost/api/attestation/${VALID_HASH}`), {
        params: Promise.resolve({ recordHash: VALID_HASH }),
      });

      expect(mockLogInfo).toHaveBeenLastCalledWith(
        "Attestation lookup completed",
        {
          routeClass: "attestation_lookup",
          outcome: "not_found",
          latencyBucket: bucket,
        },
      );
      const context = mockLogInfo.mock.calls.at(-1)?.[1];
      expect(context).not.toHaveProperty("latencyMs");
      now.mockRestore();
    },
  );
});
