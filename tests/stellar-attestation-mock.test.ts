import { describe, expect, it, vi } from "vitest";

// getAttestation wraps its lookup in next/cache's unstable_cache, which
// requires a full Next.js request/render context to have an incremental
// cache available. Outside that context (here, under Vitest) it throws, so
// tests stub it with a simple in-memory memoizer instead.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => {
    const cacheStore = new Map<string, unknown>();
    return async (...args: unknown[]) => {
      const key = JSON.stringify(args);
      if (cacheStore.has(key)) {
        return cacheStore.get(key);
      }
      const result = await fn(...args);
      cacheStore.set(key, result);
      return result;
    };
  },
}));

// No ATTESTATION_CONTRACT_ID here: this exercises the local-dev / pre-deploy
// fallback path, where getAttestation short-circuits to the in-memory mock and
// never touches the SDK. Env must be seeded before lib/env is imported.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  // Intentionally NOT setting ATTESTATION_CONTRACT_ID.
});

// The SDK must still be mockable even though it's never invoked on this path,
// so we don't accidentally hit the network if the guard regresses.
vi.mock("@stellar/stellar-sdk", () => ({
  Account: class {},
  BASE_FEE: "100",
  Contract: class {
    call() {
      throw new Error("SDK should not be called on the mock fallback path");
    }
  },
  TransactionBuilder: class {},
  nativeToScVal: (val: unknown) => val,
  rpc: { Server: class {}, Api: { isSimulationSuccess: () => true } },
  scValToNative: (scval: unknown) => scval,
}));

import { getAttestation, DEMO_VERIFIED_RECORD_HASH } from "@/lib/stellar/attestation";

describe("getAttestation (local-dev mock fallback)", () => {
  it("returns the demo attestation for the fixture hash when no contract is configured", async () => {
    const result = await getAttestation(DEMO_VERIFIED_RECORD_HASH);

    expect(result).not.toBeNull();
    expect(result?.recordHash).toBe(DEMO_VERIFIED_RECORD_HASH);
  });

  it("returns null for an unknown hash under the mock fallback", async () => {
    const result = await getAttestation("e".repeat(64));

    expect(result).toBeNull();
  });
});
