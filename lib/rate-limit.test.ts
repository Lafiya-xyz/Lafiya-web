import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock function hoisted before module imports are processed, matching the
// convention in app/(auth)/signin/actions.test.ts.
const { mockHeaders } = vi.hoisted(() => ({
  mockHeaders: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

function headersFrom(values: Record<string, string>) {
  return {
    get: (name: string) => values[name.toLowerCase()] ?? null,
  };
}

import { FALLBACK_CLIENT_IP, bucketIpv6ToSlash64, getClientIp } from "./rate-limit";

describe("getClientIp (#517)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("CLIENT_IP_HEADER", "x-vercel-forwarded-for");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    mockHeaders.mockResolvedValue(headersFrom({}));
  });

  it("returns the fallback when no relevant header is present", async () => {
    expect(await getClientIp()).toBe(FALLBACK_CLIENT_IP);
  });

  it("prefers the platform-injected header over X-Forwarded-For entirely", async () => {
    mockHeaders.mockResolvedValue(
      headersFrom({
        "x-vercel-forwarded-for": "203.0.113.9",
        "x-forwarded-for": "9.9.9.9, 203.0.113.1",
      }),
    );
    expect(await getClientIp()).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip when X-Forwarded-For is absent", async () => {
    mockHeaders.mockResolvedValue(headersFrom({ "x-real-ip": "198.51.100.7" }));
    expect(await getClientIp()).toBe("198.51.100.7");
  });

  it("keeps existing single-entry X-Forwarded-For behavior unchanged (1 trusted hop)", async () => {
    mockHeaders.mockResolvedValue(headersFrom({ "x-forwarded-for": "192.168.1.1" }));
    expect(await getClientIp()).toBe("192.168.1.1");
  });

  describe("table-driven: spoofed chains, IPv6, malformed values, missing header", () => {
    const cases: {
      name: string;
      xForwardedFor?: string;
      xRealIp?: string;
      trustedProxyHops?: string;
      expected: string;
    }[] = [
      {
        name: "spoofed leftmost entry is ignored -- rightmost (proxy-appended) entry wins",
        xForwardedFor: "1.2.3.4, 203.0.113.55",
        expected: "203.0.113.55",
      },
      {
        name: "attacker rotates the leftmost entry on every request -- result stays fixed",
        xForwardedFor: "6.6.6.6, 203.0.113.55",
        expected: "203.0.113.55",
      },
      {
        name: "attacker adds many fake hops -- still only the rightmost is trusted",
        xForwardedFor: "1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, 203.0.113.55",
        expected: "203.0.113.55",
      },
      {
        name: "two trusted hops selects the second-from-right entry",
        xForwardedFor: "1.1.1.1, 203.0.113.55, 10.0.0.1",
        trustedProxyHops: "2",
        expected: "203.0.113.55",
      },
      {
        name: "IPv6 address is bucketed to its /64 network",
        xForwardedFor: "2001:db8:abcd:1234:5678:9abc:def0:1111",
        expected: "2001:db8:abcd:1234::",
      },
      {
        name: "two different IPv6 host addresses in the same /64 bucket identically",
        xForwardedFor: "2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd",
        expected: "2001:db8:abcd:1234::",
      },
      {
        name: "malformed rightmost entry falls through to x-real-ip",
        xForwardedFor: "1.2.3.4, not-an-ip",
        xRealIp: "198.51.100.42",
        expected: "198.51.100.42",
      },
      {
        name: "malformed rightmost entry with no other header falls back to the default",
        xForwardedFor: "1.2.3.4, definitely-not-an-ip",
        expected: FALLBACK_CLIENT_IP,
      },
      {
        name: "empty X-Forwarded-For header falls through to x-real-ip",
        xForwardedFor: "",
        xRealIp: "198.51.100.42",
        expected: "198.51.100.42",
      },
      {
        name: "missing header entirely falls back to the default",
        expected: FALLBACK_CLIENT_IP,
      },
      {
        name: "trusted hops exceeding the chain length clamps to the leftmost entry",
        xForwardedFor: "203.0.113.55",
        trustedProxyHops: "5",
        expected: "203.0.113.55",
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, async () => {
        if (testCase.trustedProxyHops) {
          vi.stubEnv("TRUSTED_PROXY_HOPS", testCase.trustedProxyHops);
        }
        mockHeaders.mockResolvedValue(
          headersFrom({
            ...(testCase.xForwardedFor !== undefined
              ? { "x-forwarded-for": testCase.xForwardedFor }
              : {}),
            ...(testCase.xRealIp ? { "x-real-ip": testCase.xRealIp } : {}),
          }),
        );
        expect(await getClientIp()).toBe(testCase.expected);
      });
    }
  });
});

describe("bucketIpv6ToSlash64 (#517)", () => {
  it("zeroes the host portion, keeping only the top 4 groups", () => {
    expect(bucketIpv6ToSlash64("2001:db8:abcd:1234:5678:9abc:def0:1111")).toBe(
      "2001:db8:abcd:1234::",
    );
  });

  it("expands a leading '::' before bucketing", () => {
    expect(bucketIpv6ToSlash64("::1")).toBe("0:0:0:0::");
  });

  it("expands a trailing '::' before bucketing", () => {
    expect(bucketIpv6ToSlash64("2001:db8::")).toBe("2001:db8:0:0::");
  });

  it("returns the input unchanged if it cannot be parsed as hex groups", () => {
    // IPv4-mapped IPv6 -- deliberately out of scope, see the doc comment.
    expect(bucketIpv6ToSlash64("::ffff:192.0.2.1")).toBe("::ffff:192.0.2.1");
  });
});
