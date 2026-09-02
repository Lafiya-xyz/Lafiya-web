import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// docs/card-caching-strategy.md is the source of truth for what the live
// /card/* response headers must be: "Live: /card/* uses dynamic,
// `private, no-store` responses. Referrer, CSP, and robot headers protect
// the bearer URL from third-party leakage." This test pins that contract
// down so a future proxy.ts edit can't silently regress the offline
// strategy documented there.

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
    },
  })),
}));

vi.mock("@/lib/env", () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

import { proxy } from "./proxy";

describe("proxy headers for /card/[id]", () => {
  it("matches the caching strategy documented in docs/card-caching-strategy.md", async () => {
    const request = new NextRequest(
      "http://localhost:3000/card/11111111-1111-1111-1111-111111111111",
    );

    const response = await proxy(request);

    // "Live: /card/* uses dynamic, `private, no-store` responses."
    expect(response.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    // "Referrer, CSP, and robot headers protect the bearer URL from
    // third-party leakage."
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Robots-Tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'self'",
    );
  });

  it("does not apply the bearer-URL header set to unrelated routes", async () => {
    const request = new NextRequest("http://localhost:3000/");

    const response = await proxy(request);

    expect(response.headers.get("Cache-Control")).not.toBe(
      "private, no-store, max-age=0",
    );
  });
});
