import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
  serverEnv: {
    ATTESTATION_CONTRACT_ID: "contract-id",
    CHW_INCENTIVE_POOL_ADDRESS: "pool-address",
    PAYOUT_INDEXER_CRON_SECRET: "test-cron-secret",
    PAYOUT_INDEXER_START_LEDGER: 100,
    PAYOUT_INDEXER_START_PAYMENT_CURSOR: "0",
    SOROBAN_RPC_URL: "https://rpc.example",
    STELLAR_HORIZON_URL: "https://horizon.example",
    STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    STELLAR_USDC_ISSUER: "usdc-issuer",
  },
  runOnce: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));
vi.mock("@/lib/env-server", () => ({
  serverEnv: mocks.serverEnv,
}));
vi.mock("@/lib/stellar/payout-indexer/indexer", () => ({
  PayoutIndexer: vi.fn().mockImplementation(() => ({
    runOnce: mocks.runOnce,
  })),
}));
vi.mock("@/lib/stellar/payout-indexer/sources", () => ({
  HorizonPayoutSource: vi.fn(),
  SorobanAttestationSource: vi.fn(),
}));
vi.mock("@/lib/stellar/payout-indexer/store", () => ({
  SupabasePayoutIndexerStore: vi.fn(),
}));

import { POST } from "./route";

function enabledConfig() {
  return { payoutIndexer: { enabled: true } };
}

describe("POST /api/internal/payout-indexer", () => {
  it("succeeds for an authorized internal invocation and returns the indexer summary shape", async () => {
    mocks.getRuntimeConfig.mockReturnValue(enabledConfig());
    const summary = {
      attestations: 2,
      payments: 1,
      attestationCursor: "att-cursor",
      paymentCursor: "pay-cursor",
    };
    mocks.runOnce.mockResolvedValue(summary);

    const request = new Request("http://localhost/api/internal/payout-indexer", {
      method: "POST",
      headers: { authorization: "Bearer test-cron-secret" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
  });

  it("rejects a call with no Authorization header (unauthenticated/external caller)", async () => {
    mocks.getRuntimeConfig.mockReturnValue(enabledConfig());

    const request = new Request("http://localhost/api/internal/payout-indexer", {
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.runOnce).not.toHaveBeenCalled();
  });

  it("rejects a call bearing an incorrect/forged secret", async () => {
    mocks.getRuntimeConfig.mockReturnValue(enabledConfig());

    const request = new Request("http://localhost/api/internal/payout-indexer", {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(mocks.runOnce).not.toHaveBeenCalled();
  });

  it("returns 503 (not authorization) when the indexer is not configured, without leaking whether auth was checked", async () => {
    mocks.getRuntimeConfig.mockReturnValue({ payoutIndexer: { enabled: false } });

    const request = new Request("http://localhost/api/internal/payout-indexer", {
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Payout indexer is not configured",
    });
  });
});
