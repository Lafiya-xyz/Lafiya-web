import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  getRpcResolutionStatus: vi.fn(() => "verified"),
  createAdminClient: vi.fn(),
  getHealth: vi.fn(),
  getFlagStates: vi.fn(),
  getOutboxLag: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  getRpcResolutionStatus: mocks.getRpcResolutionStatus,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/stellar/verification-indexer/trust-state", () => ({
  getContractTrustState: vi.fn().mockResolvedValue("trusted"),
}));
vi.mock("@/lib/flags", () => ({
  getFlagStates: mocks.getFlagStates,
}));
vi.mock("@/lib/outbox/dispatcher", () => ({
  getOutboxLag: mocks.getOutboxLag,
}));
vi.mock("@/lib/env-server", () => ({
  serverEnv: { SOROBAN_RPC_URL: "https://soroban-rpc.example" },
}));
vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    // `new rpc.Server(...)` requires a real constructor — an arrow-function
    // mock implementation isn't constructible and silently drops the
    // returned instance shape.
    Server: vi.fn().mockImplementation(function () {
      return { getHealth: mocks.getHealth };
    }),
  },
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
    rpcEndpoints: { policy: "allowlist" },
  };
}

function adminClient({ supabaseError }: { supabaseError?: Error } = {}) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => {
        if (table === "indexer_gap_incidents") {
          return {
            is: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            })),
          };
        }
        return {
          limit: supabaseError
            ? vi.fn().mockRejectedValue(supabaseError)
            : vi.fn().mockResolvedValue({ error: null }),
          is: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
        };
      }),
    })),
  };
}

describe("readiness route", () => {
  it("returns a non-sensitive ready deployment state with a per-dependency breakdown", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    mocks.createAdminClient.mockReturnValue(adminClient());
    mocks.getHealth.mockResolvedValue({ status: "healthy" });
    mocks.getFlagStates.mockResolvedValue({});
    mocks.getOutboxLag.mockResolvedValue({
      lagMs: 0,
      pendingCount: 0,
      deadCount: 0,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      status: "ready",
      build: { revision: "a1b2c3d4", schemaCompatibility: "20260821170000" },
      environment: "staging",
      components: {
        supabase: "ok",
        stellar: "ok",
        verificationIndexer: "ok",
        attestation: "live",
        attestationGovernance: "trusted",
        payoutIndexer: "enabled",
        sentry: "enabled",
        outbox: {
          status: "ok",
          pendingCount: 0,
          deadCount: 0,
          lagMs: 0,
        },
        rpcEndpoints: { policy: "allowlist", resolution: "verified" },
      },
      flags: {},
    });
  });

  it("surfaces dead outbox rows without exposing payloads", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    mocks.createAdminClient.mockReturnValue(adminClient());
    mocks.getHealth.mockResolvedValue({ status: "healthy" });
    mocks.getFlagStates.mockResolvedValue({});
    mocks.getOutboxLag.mockResolvedValue({
      lagMs: 12_000,
      pendingCount: 4,
      deadCount: 2,
    });

    const body = JSON.stringify(await (await GET()).json());

    expect(body).toContain('"outbox"');
    expect(body).toContain('"deadCount":2');
    expect(body).not.toContain("payload");
    expect(body).not.toContain("commitment");
  });

  it("reports RPC URL validation results without exposing the configured URLs", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    mocks.createAdminClient.mockReturnValue(adminClient());
    mocks.getHealth.mockResolvedValue({ status: "healthy" });
    mocks.getFlagStates.mockResolvedValue({});
    mocks.getOutboxLag.mockResolvedValue({
      lagMs: 0,
      pendingCount: 0,
      deadCount: 0,
    });

    const body = JSON.stringify(await (await GET()).json());

    expect(body).toContain('"rpcEndpoints"');
    expect(body).not.toContain("soroban-rpc.example");
  });

  it("fails closed with a 503 when Supabase cannot be reached", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    mocks.createAdminClient.mockReturnValue(
      adminClient({ supabaseError: new Error("connection unavailable") }),
    );
    mocks.getHealth.mockResolvedValue({ status: "healthy" });
    mocks.getFlagStates.mockResolvedValue({});
    mocks.getOutboxLag.mockResolvedValue({
      lagMs: 0,
      pendingCount: 0,
      deadCount: 0,
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "not_ready",
      components: { supabase: "unreachable", stellar: "ok" },
    });
  });

  it("fails closed with a 503 and names Stellar when the Soroban RPC endpoint is unreachable", async () => {
    mocks.getRuntimeConfig.mockReturnValue(readyConfig());
    mocks.createAdminClient.mockReturnValue(adminClient());
    mocks.getHealth.mockRejectedValue(new Error("timeout"));
    mocks.getFlagStates.mockResolvedValue({});
    mocks.getOutboxLag.mockResolvedValue({
      lagMs: 0,
      pendingCount: 0,
      deadCount: 0,
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "not_ready",
      components: { supabase: "ok", stellar: "unreachable" },
    });
  });
});
