import { describe, expect, it, vi } from "vitest";

// Env must be set before any module (notably lib/env) is imported, because
// serverEnv parses process.env at module-evaluation time. vi.hoisted runs
// before all hoisted imports, so this is the safe place to seed it.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  // A configured contract id flips getAttestation into the real-RPC path.
  process.env.ATTESTATION_CONTRACT_ID = "C1111111111111111111111111111111111111111111111111111111111111111";
});

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

// Recorded-RPC-fixture style mock: no network, fully deterministic. We drive
// the simulation outcome per-test via mutable holders so we can assert both
// the happy path (Attestation decoded) and the missing-record path (null).
const calls = vi.hoisted(() => ({
  serverUrl: "",
  simulateArgs: null as unknown,
  contractCalls: [] as Array<{ method: string; arg: unknown }>,
  simulateResult: null as unknown,
}));

vi.mock("@stellar/stellar-sdk", () => {
  class FakeAccount {
    constructor(
      public id: string,
      public sequence: string,
    ) {}
  }

  class FakeServer {
    constructor(url: string) {
      calls.serverUrl = url;
    }
    async simulateTransaction(tx: unknown) {
      calls.simulateArgs = tx;
      return calls.simulateResult;
    }
  }

  class FakeContract {
    constructor(public contractId: string) {}
    call(method: string, arg: unknown) {
      calls.contractCalls.push({ method, arg });
      return { __op: method };
    }
  }

  return {
    Account: FakeAccount,
    BASE_FEE: "100",
    Contract: FakeContract,
    TransactionBuilder: class {
      addOperation() {
        return this;
      }
      setTimeout() {
        return this;
      }
      build() {
        return { __tx: true };
      }
    },
    nativeToScVal: (val: unknown) => ({ __scval: val }),
    rpc: {
      Server: FakeServer,
      Api: {
        isSimulationSuccess: (sim: { __ok?: boolean }) => sim.__ok === true,
      },
    },
    scValToNative: (scval: unknown) => scval,
    Keypair: { random: () => ({ publicKey: () => "GFAKEKEY" }) },
  };
});

import { getAttestation } from "@/lib/stellar/attestation";

describe("getAttestation (real Soroban RPC path)", () => {
  it("calls get_attestation on the configured contract with the record hash as bytes", async () => {
    calls.simulateResult = { __ok: true, result: { retval: null } };

    await getAttestation("a".repeat(64));

    expect(calls.serverUrl).toBe("https://soroban-testnet.stellar.org");
    expect(calls.contractCalls).toHaveLength(1);
    expect(calls.contractCalls[0].method).toBe("get_attestation");
    // The hex hash is encoded to bytes and wrapped by nativeToScVal.
    expect(calls.contractCalls[0].arg).toEqual({ __scval: expect.any(Buffer) });
  });

  it("returns the decoded Attestation on a successful simulation", async () => {
    const recordHash = "b".repeat(64);
    calls.simulateResult = {
      __ok: true,
      result: {
        retval: {
          record_hash: "b".repeat(64),
          attester: "GATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          timestamp: 1735689600,
        },
      },
    };

    const result = await getAttestation(recordHash);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      recordHash,
      attester: "GATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      timestamp: 1735689600,
    });
  });

  it("returns null when the simulation errors (record hash has no attestation)", async () => {
    calls.simulateResult = { __ok: false, error: "ContractError" };

    const result = await getAttestation("c".repeat(64));

    expect(result).toBeNull();
  });

  it("returns null when the simulation succeeds but yields no return value", async () => {
    calls.simulateResult = { __ok: true, result: { retval: undefined } };

    const result = await getAttestation("d".repeat(64));

    expect(result).toBeNull();
  });
});
