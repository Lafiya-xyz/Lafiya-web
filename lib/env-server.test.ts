import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
  vi.stubEnv("STELLAR_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");
  vi.stubEnv("SOROBAN_RPC_URL", "https://soroban-testnet.stellar.org");
});

describe("environment schemas", () => {
  it("keeps the client schema limited to public variables", async () => {
    const { clientEnvSchema } = await import("./env");
    const parsed = clientEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    });

    expect(parsed.success).toBe(true);
  });

  it("extends the client schema with server-only variables", async () => {
    const { serverEnvSchema } = await import("./env-server");
    const parsed = serverEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      ATTESTATION_CONTRACT_ID: "contract-id",
      ATTESTATION_MOCK_MODE: "false",
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      STELLAR_USDC_ISSUER: "GISSUER",
      CHW_INCENTIVE_POOL_ADDRESS: "GPOOL",
      PAYOUT_INDEXER_START_LEDGER: "123",
      PAYOUT_INDEXER_START_PAYMENT_CURSOR: "0",
      PAYOUT_INDEXER_CRON_SECRET: "a-secure-cron-secret",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.PAYOUT_INDEXER_START_LEDGER).toBe(123);
    }
  });

  it("rejects a production mock or missing attestation contract", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // The module also validates the live process environment on import. Keep
    // that valid so this test can exercise the schema with an invalid input.
    vi.stubEnv("ATTESTATION_CONTRACT_ID", "contract-id");
    vi.stubEnv("ATTESTATION_MOCK_MODE", "false");
    const { serverEnvSchema } = await import("./env-server");
    const parsed = serverEnvSchema.safeParse({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      ATTESTATION_MOCK_MODE: "true",
    });
    expect(parsed.success).toBe(false);
  });
});
