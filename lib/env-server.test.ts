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

  it("names the exact missing variable when a required server variable is absent at startup", async () => {
    vi.stubEnv("SOROBAN_RPC_URL", "");

    await expect(import("./env-server")).rejects.toThrow(
      /missing or invalid required environment variable\(s\): SOROBAN_RPC_URL/,
    );
  });

  it("produces a human-readable, non-generic message that points at .env setup", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    try {
      await import("./env-server");
      expect.unreachable("expected env-server import to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(message).toContain(".env.example");
      expect(message).not.toBe("INVALID_RUNTIME_CONFIGURATION:MALFORMED_VALUE");
    }
  });
});
