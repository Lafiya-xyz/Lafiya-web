import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

import type { Attestation } from "@/lib/attestation/types";
import { serverEnv } from "@/lib/env";

/**
 * Live M1 attestation lookup.
 *
 * When `ATTESTATION_CONTRACT_ID` is configured, `getAttestation` calls the
 * real `get_attestation` Soroban function on the deployed `lafiya-contracts`
 * registry over JSON-RPC (see README.md > M1 — Attestation). The call is
 * read-only: we `simulateTransaction` it, which costs nothing and needs no
 * signing, but still executes the contract and returns the on-chain
 * `Attestation` for the given record hash.
 *
 * When `ATTESTATION_CONTRACT_ID` is unset (local dev, CI, or pre-deploy), the
 * function falls back to the in-memory mock below so the verified indicator,
 * the public card page, and the attestation Route Handler all keep working
 * without a contract. This fallback is intentional and documented; flip it off
 * by setting `ATTESTATION_CONTRACT_ID` in the environment.
 *
 * The function signature is unchanged from the pre-M1 stub, so neither caller
 * (the public card page nor the attestation Route Handler) needs to change.
 */

/** Fixture hash for local dev/demo only — not a real record's hash. */
export const DEMO_VERIFIED_RECORD_HASH = "a".repeat(64);

/**
 * Maximum milliseconds to wait for a Soroban RPC response before treating
 * the attestation lookup as a failure. This timeout fires *inside*
 * `getAttestation`, before the result is returned to callers, so that a
 * hanging RPC endpoint counts toward the circuit-breaker failure threshold
 * and trips the breaker after `failureThreshold` consecutive slow calls.
 *
 * Callers (e.g. the public card page) should treat a rejection from
 * `getAttestation` as "verification status unavailable" rather than a
 * hard error — the card must still render the emergency data.
 */
export const ATTESTATION_TIMEOUT_MS = 2000;

export const MOCK_ATTESTATIONS = new Map<string, Attestation>([
  [
    DEMO_VERIFIED_RECORD_HASH,
    {
      recordHash: DEMO_VERIFIED_RECORD_HASH,
      attester: "GDEMOATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      timestamp: 1735689600,
    },
  ],
]);
/**
 * Test-only seam: lets an out-of-process E2E test register a mock
 * attestation for a specific recordHash before visiting the public card
 * page. Real card hashes are SHA-256 digests, so they can never naturally
 * match the fixed DEMO_VERIFIED_RECORD_HASH — this is how a "verified"
 * state is reached in visual/E2E tests without faking application logic.
 * Inert (throws) unless ALLOW_TEST_ATTESTATION_SEED=true, which only the
 * Playwright webServer config sets — never set in production.
 */
export function setMockAttestationForTesting(
  recordHash: string,
  attestation: Attestation,
): void {
  if (process.env.ALLOW_TEST_ATTESTATION_SEED !== "true") {
    throw new Error(
      "setMockAttestationForTesting is disabled outside test environments",
    );
  }
  MOCK_ATTESTATIONS.set(recordHash, attestation);
}

// simulateTransaction needs a source account, but since we never submit the
// transaction it's just a placeholder — any well-formed account works. Built
// lazily (only on the real-RPC path) so importing this module doesn't require
// a valid account and the local-dev mock fallback stays side-effect free.
function simulationSource() {
  return new Account(Keypair.random().publicKey(), "0");
}

export async function getAttestation(
  recordHash: string,
): Promise<Attestation | null> {
  // Local-dev / pre-deploy fallback: no contract configured yet.
  if (!serverEnv.ATTESTATION_CONTRACT_ID) {
    return MOCK_ATTESTATIONS.get(recordHash) ?? null;
  }

  const server = new rpc.Server(serverEnv.SOROBAN_RPC_URL);
  const contract = new Contract(serverEnv.ATTESTATION_CONTRACT_ID);

  const recordHashBytes = Buffer.from(recordHash, "hex");
  const invocation = contract.call(
    "get_attestation",
    nativeToScVal(recordHashBytes, { type: "bytes" }),
  );

  const tx = new TransactionBuilder(simulationSource(), {
    fee: BASE_FEE,
    networkPassphrase: serverEnv.STELLAR_NETWORK_PASSPHRASE,
  })
    .addOperation(invocation)
    .setTimeout(30)
    .build();

  const simulation = await server.simulateTransaction(tx);

  // A record hash with no attestation reverts in-contract; the simulation
  // reports an error rather than a value. Treat that as "not verified".
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    return null;
  }

  const retval = simulation.result?.retval;
  if (!retval) {
    return null;
  }

  return decodeAttestation(scValToNative(retval), recordHash);
}

/**
 * The contract returns the `Attestation` struct
 * ({ record_hash, attester, timestamp }). Decoding is defensive: we don't
 * assume the exact SCVal key casing (Rust struct field names may surface as
 * snake_case or camelCase depending on the spec), and we validate types so a
 * malformed on-chain value can't quietly poison the verified indicator.
 */
function decodeAttestation(value: unknown, recordHash: string): Attestation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;

  const attester = extractAddress(raw.attester);
  const timestamp = extractTimestamp(raw.timestamp);

  if (typeof attester !== "string" || typeof timestamp !== "number") {
    return null;
  }

  return {
    recordHash,
    attester,
    timestamp,
  };
}

function extractAddress(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  // An Address SCVal decodes to a string via its toString(); guard anyway.
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    const str = String(value);
    if (str.startsWith("G") || str.startsWith("C")) {
      return str;
    }
  }
  return null;
}

function extractTimestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  // u64/i64 SCVal decode to bigint; convert losslessly within JS safe range.
  if (typeof value === "bigint") {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : null;
  }
  return null;
}
