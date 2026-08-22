import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));

import { GET } from "./route";

function readyConfig() {
  return {
    deployment: "staging",
    buildRevision: "a1b2c3d4",
    schemaCompatibility: "20260821170000",
    attestation: {
      mode: "live",
      contractConfigured: true,
      protocolConfigured: true,
    },
    payoutIndexer: { enabled: true },
    sentry: { enabled: true },
  };
}

describe("readiness route", () => {
  it("returns a non-sensitive ready deployment state", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    const limit = vi.fn().mockResolvedValue({ error: null });
    mocks.createAdminClient.mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => ({ limit })) })),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      status: "ready",
      build: { revision: "a1b2c3d4", schemaCompatibility: "20260821170000" },
      environment: "staging",
      components: {
        database: "ready",
        attestation: "live",
        payoutIndexer: "enabled",
        sentry: "enabled",
      },
    });
  });

  it("fails closed when the database cannot be probed", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    const limit = vi
      .fn()
      .mockRejectedValue(new Error("connection unavailable"));
    mocks.createAdminClient.mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => ({ limit })) })),
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "not_ready",
      components: { database: "unavailable" },
    });
  });
});
