/**
 * Unit tests for lib/url/getBaseUrl.ts
 *
 * getBaseUrl() uses Next.js `headers()` to read x-forwarded-host, host, and
 * x-forwarded-proto from the incoming request. We mock that import so tests
 * run without a real HTTP context.
 *
 * Scenarios covered:
 *   1. Local development   — host = localhost:3000, no forwarded headers → http
 *   2. 127.0.0.1 loopback  — host = 127.0.0.1:3000                       → http
 *   3. Vercel preview      — x-forwarded-host + x-forwarded-proto          → https
 *   4. Production          — x-forwarded-host = example.com                → https (inferred)
 *   5. Explicit https proto — x-forwarded-proto overrides loopback heuristic
 *   6. No trailing slash   — returned URL must not end with "/"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock next/headers before importing the module under test so that
// `import { headers } from "next/headers"` inside getBaseUrl.ts is
// intercepted from the start.
// ---------------------------------------------------------------------------
const mockHeadersGet = vi.fn<[string], string | null>();

vi.mock("next/headers", () => ({
  headers: () => ({
    get: mockHeadersGet,
  }),
}));

// Import after the mock is registered.
import { getBaseUrl } from "./getBaseUrl";

// ---------------------------------------------------------------------------
// Helper — sets up mockHeadersGet to return the given map for known header
// names and null for anything else.
// ---------------------------------------------------------------------------
function mockHeaders(values: Record<string, string | null>) {
  mockHeadersGet.mockImplementation((name: string) => values[name] ?? null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("getBaseUrl", () => {
  beforeEach(() => {
    mockHeadersGet.mockReset();
  });

  it("returns http for localhost (local dev)", async () => {
    mockHeaders({
      "x-forwarded-host": null,
      host: "localhost:3000",
      "x-forwarded-proto": null,
    });

    const url = await getBaseUrl();
    expect(url).toBe("http://localhost:3000");
  });

  it("returns http for 127.0.0.1 loopback", async () => {
    mockHeaders({
      "x-forwarded-host": null,
      host: "127.0.0.1:3000",
      "x-forwarded-proto": null,
    });

    const url = await getBaseUrl();
    expect(url).toBe("http://127.0.0.1:3000");
  });

  it("returns https for a Vercel preview URL (x-forwarded-host + x-forwarded-proto)", async () => {
    mockHeaders({
      "x-forwarded-host": "my-app-git-feat-abc123.vercel.app",
      host: "my-app-git-feat-abc123.vercel.app",
      "x-forwarded-proto": "https",
    });

    const url = await getBaseUrl();
    expect(url).toBe("https://my-app-git-feat-abc123.vercel.app");
  });

  it("prefers x-forwarded-host over host header", async () => {
    mockHeaders({
      "x-forwarded-host": "example.com",
      host: "10.0.0.1:3000",
      "x-forwarded-proto": "https",
    });

    const url = await getBaseUrl();
    expect(url).toBe("https://example.com");
  });

  it("infers https for a non-loopback host when x-forwarded-proto is absent", async () => {
    mockHeaders({
      "x-forwarded-host": null,
      host: "example.com",
      "x-forwarded-proto": null,
    });

    const url = await getBaseUrl();
    expect(url).toBe("https://example.com");
  });

  it("respects explicit x-forwarded-proto even for loopback host", async () => {
    // Unusual but possible behind some proxies.
    mockHeaders({
      "x-forwarded-host": null,
      host: "localhost:3000",
      "x-forwarded-proto": "https",
    });

    const url = await getBaseUrl();
    expect(url).toBe("https://localhost:3000");
  });

  it("falls back to localhost:3000 when all headers are absent", async () => {
    mockHeaders({
      "x-forwarded-host": null,
      host: null,
      "x-forwarded-proto": null,
    });

    const url = await getBaseUrl();
    expect(url).toBe("http://localhost:3000");
  });

  it("does not include a trailing slash", async () => {
    mockHeaders({
      "x-forwarded-host": "example.com",
      host: null,
      "x-forwarded-proto": "https",
    });

    const url = await getBaseUrl();
    expect(url.endsWith("/")).toBe(false);
  });

  it("handles production domain without port", async () => {
    mockHeaders({
      "x-forwarded-host": "lafiya-web.vercel.app",
      host: "lafiya-web.vercel.app",
      "x-forwarded-proto": "https",
    });

    const url = await getBaseUrl();
    expect(url).toBe("https://lafiya-web.vercel.app");
  });
});
