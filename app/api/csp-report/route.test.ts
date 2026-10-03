import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGetClientIp, mockCheckAndIncrementFrequency, mockLogWarn } =
  vi.hoisted(() => ({
    mockGetClientIp: vi.fn(async () => "203.0.113.9"),
    mockCheckAndIncrementFrequency: vi.fn(async () => ({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
    })),
    mockLogWarn: vi.fn(),
  }));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: mockGetClientIp,
}));
vi.mock("@/lib/frequency-limit", () => ({
  checkAndIncrementFrequency: mockCheckAndIncrementFrequency,
}));
vi.mock("@/lib/logging/logger", () => ({
  logWarn: mockLogWarn,
}));

import {
  POST,
  blockedOriginOf,
  redactReportUrl,
} from "./route";

function postRequest(body: string, contentType: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body,
  });
}

describe("redactReportUrl (#520)", () => {
  it("strips a legacy /card/[id] capability from the path", () => {
    expect(
      redactReportUrl("https://lafiya.app/card/550e8400-e29b-41d4-a716-446655440000?foo=bar"),
    ).toBe("https://lafiya.app/card/[redacted]");
  });

  it("strips a /card/c/[token] capability from the path", () => {
    expect(redactReportUrl("https://lafiya.app/card/c/abcDEF123token")).toBe(
      "https://lafiya.app/card/c/[redacted]",
    );
  });

  it("strips query strings on non-card URLs too", () => {
    expect(redactReportUrl("https://lafiya.app/profile?session=abc123")).toBe(
      "https://lafiya.app/profile",
    );
  });

  it("passes through non-URL values (inline, eval, etc.) unchanged", () => {
    expect(redactReportUrl("inline")).toBe("inline");
    expect(redactReportUrl("eval")).toBe("eval");
  });

  it("returns undefined for a missing value", () => {
    expect(redactReportUrl(undefined)).toBeUndefined();
  });
});

describe("blockedOriginOf (#520)", () => {
  it("returns only the host, not the full path", () => {
    expect(blockedOriginOf("https://evil.example.com/malicious.js?x=1")).toBe(
      "evil.example.com",
    );
  });

  it("passes through non-URL values unchanged", () => {
    expect(blockedOriginOf("inline")).toBe("inline");
  });

  it("returns 'unknown' when absent", () => {
    expect(blockedOriginOf(undefined)).toBe("unknown");
  });
});

describe("POST /api/csp-report (#520)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockResolvedValue("203.0.113.9");
    mockCheckAndIncrementFrequency.mockResolvedValue({
      allowed: true,
      count: 1,
      retryAfterSeconds: 0,
    });
  });

  it("accepts a legacy application/csp-report body and never logs the capability token", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://lafiya.app/card/c/eyJhbGciOiJIUzI1NiJ9.secret-token",
        "blocked-uri": "https://evil.example.com/x.js",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        disposition: "enforce",
      },
    });

    const res = await POST(postRequest(body, "application/csp-report"));

    expect(res.status).toBe(204);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [, context] = mockLogWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context.routeClass).toBe("https://lafiya.app/card/c/[redacted]");
    expect(context.blockedOrigin).toBe("evil.example.com");
    expect(context.directive).toBe("script-src-elem");
    expect(JSON.stringify(context)).not.toContain("secret-token");
  });

  it("accepts an application/reports+json body (array of report objects)", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        url: "https://lafiya.app/card/11111111-1111-1111-1111-111111111111",
        body: {
          documentURL: "https://lafiya.app/card/11111111-1111-1111-1111-111111111111",
          blockedURL: "https://evil.example.com/y.js",
          effectiveDirective: "script-src-elem",
          disposition: "enforce",
        },
      },
    ]);

    const res = await POST(postRequest(body, "application/reports+json"));

    expect(res.status).toBe(204);
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [, context] = mockLogWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context.routeClass).toBe("https://lafiya.app/card/[redacted]");
    expect(JSON.stringify(context)).not.toContain(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("ignores report entries that are not csp-violation type", async () => {
    const body = JSON.stringify([{ type: "deprecation", body: {} }]);

    const res = await POST(postRequest(body, "application/reports+json"));

    expect(res.status).toBe(204);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("returns 413 when Content-Length exceeds the body size limit", async () => {
    const res = await POST(
      postRequest("{}", "application/csp-report", {
        "content-length": String(17 * 1024),
      }),
    );

    expect(res.status).toBe(413);
    expect(mockGetClientIp).not.toHaveBeenCalled();
  });

  it("returns 413 when the actual body exceeds the limit despite no Content-Length", async () => {
    const oversized = "x".repeat(17 * 1024);
    const res = await POST(postRequest(oversized, "application/csp-report"));

    expect(res.status).toBe(413);
  });

  it("returns 429 with Retry-After when the per-IP frequency limit is exceeded", async () => {
    mockCheckAndIncrementFrequency.mockResolvedValue({
      allowed: false,
      count: 21,
      retryAfterSeconds: 42,
    });

    const res = await POST(postRequest("{}", "application/csp-report"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("keys the frequency limit by client IP", async () => {
    mockGetClientIp.mockResolvedValue("198.51.100.42");

    await POST(postRequest("{}", "application/csp-report"));

    expect(mockCheckAndIncrementFrequency).toHaveBeenCalledWith(
      "csp-report:198.51.100.42",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("acknowledges (204) a malformed JSON body instead of erroring", async () => {
    const res = await POST(postRequest("not json{{{", "application/csp-report"));

    expect(res.status).toBe(204);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("acknowledges (204) a well-formed but unrecognized body shape", async () => {
    const res = await POST(postRequest(JSON.stringify({ foo: "bar" }), "application/csp-report"));

    expect(res.status).toBe(204);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });
});
