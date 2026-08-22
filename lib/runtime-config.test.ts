import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_COMPATIBILITY,
  getRuntimeConfig,
} from "./runtime-config";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const CONTRACT_ID = `C${"A".repeat(55)}`;
const PUBLIC_KEY = `G${"A".repeat(55)}`;

type EnvOverrides = Record<string, string | undefined>;

function baseEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    STELLAR_NETWORK_PASSPHRASE: TESTNET,
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function productionEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return baseEnv({
    NODE_ENV: "production",
    LAFIYA_DEPLOYMENT_ENV: "production",
    LAFIYA_BUILD_REVISION: "a1b2c3d4",
    LAFIYA_SCHEMA_COMPATIBILITY: CURRENT_SCHEMA_COMPATIBILITY,
    STELLAR_NETWORK_PASSPHRASE: MAINNET,
    SOROBAN_RPC_URL: "https://soroban-mainnet.example",
    ATTESTATION_MODE: "live",
    ATTESTATION_CONTRACT_ID: CONTRACT_ID,
    CHW_PROTOCOL_EPOCH_ID: "epoch-2026-08",
    CHW_PROTOCOL_INTENT_SIGNING_KEY: "managed-signing-key-reference",
    SENTRY_ENABLED: "true",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    ...overrides,
  });
}

describe("runtime configuration matrix", () => {
  it("keeps intentional local mock mode explicit and non-production", () => {
    expect(
      getRuntimeConfig(
        baseEnv({
          LAFIYA_DEPLOYMENT_ENV: "development",
          ATTESTATION_MODE: "mock",
        }),
      ),
    ).toMatchObject({
      deployment: "development",
      isProduction: false,
      attestation: { mode: "mock", contractConfigured: false },
      payoutIndexer: { enabled: false },
    });
  });

  it("rejects an unlabeled production process and production mock mode", () => {
    expect(() => getRuntimeConfig(baseEnv({ NODE_ENV: "production" }))).toThrow(
      "DEPLOYMENT_IDENTITY_REQUIRED",
    );
    expect(() =>
      getRuntimeConfig(
        productionEnv({
          ATTESTATION_MODE: "mock",
          ATTESTATION_CONTRACT_ID: undefined,
        }),
      ),
    ).toThrow("PRODUCTION_MOCK_FORBIDDEN");
  });

  it("rejects testnet, stale schema, or absent telemetry in production", () => {
    expect(() =>
      getRuntimeConfig(productionEnv({ STELLAR_NETWORK_PASSPHRASE: TESTNET })),
    ).toThrow("MAINNET_NETWORK_REQUIRED");
    expect(() =>
      getRuntimeConfig(
        productionEnv({ LAFIYA_SCHEMA_COMPATIBILITY: "20260101000000" }),
      ),
    ).toThrow("SCHEMA_COMPATIBILITY_MISMATCH");
    expect(() =>
      getRuntimeConfig(
        productionEnv({ SENTRY_ENABLED: "false", SENTRY_DSN: undefined }),
      ),
    ).toThrow("SENTRY_REQUIRED");
  });

  it("requires a real contract and complete protocol in live mode", () => {
    expect(() =>
      getRuntimeConfig(baseEnv({ ATTESTATION_MODE: "live" })),
    ).toThrow("LIVE_ATTESTATION_CONTRACT_REQUIRED");
    expect(() =>
      getRuntimeConfig(
        productionEnv({ CHW_PROTOCOL_INTENT_SIGNING_KEY: undefined }),
      ),
    ).toThrow("PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE");
  });

  it("treats the payout indexer as an all-or-nothing, live-only feature group", () => {
    expect(() =>
      getRuntimeConfig(
        baseEnv({
          PAYOUT_INDEXER_ENABLED: "true",
          ATTESTATION_MODE: "live",
          ATTESTATION_CONTRACT_ID: CONTRACT_ID,
        }),
      ),
    ).toThrow("PAYOUT_INDEXER_CONFIG_INCOMPLETE");
    expect(() =>
      getRuntimeConfig(
        baseEnv({ STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org" }),
      ),
    ).toThrow("PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION");

    expect(
      getRuntimeConfig(
        baseEnv({
          ATTESTATION_MODE: "live",
          ATTESTATION_CONTRACT_ID: CONTRACT_ID,
          PAYOUT_INDEXER_ENABLED: "true",
          STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
          STELLAR_USDC_ISSUER: PUBLIC_KEY,
          STELLAR_USDC_ASSET_CODE: "USDC",
          CHW_INCENTIVE_POOL_ADDRESS: PUBLIC_KEY,
          PAYOUT_INDEXER_START_LEDGER: "123",
          PAYOUT_INDEXER_START_PAYMENT_CURSOR: "0",
          PAYOUT_INDEXER_CRON_SECRET: "a".repeat(32),
        }),
      ).payoutIndexer,
    ).toEqual({ enabled: true });
  });

  it("returns only non-secret readiness configuration", () => {
    const config = getRuntimeConfig(productionEnv());
    expect(config).toEqual({
      deployment: "production",
      isProduction: true,
      buildRevision: "a1b2c3d4",
      schemaCompatibility: CURRENT_SCHEMA_COMPATIBILITY,
      attestation: {
        mode: "live",
        contractConfigured: true,
        protocolConfigured: true,
      },
      payoutIndexer: { enabled: false },
      sentry: { enabled: true },
    });
    expect(JSON.stringify(config)).not.toContain(
      "managed-signing-key-reference",
    );
  });
});
