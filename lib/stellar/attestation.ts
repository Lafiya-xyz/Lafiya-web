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
import { unstable_cache } from "next/cache";

import type { Attestation } from "@/lib/attestation/types";
import { serverEnv } from "@/lib/env-server";

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
 * --- Caching (Issue #17) ---
 * Attestations change rarely relative to how often a card is viewed, and each
 * live lookup is a Soroban RPC round trip. Results are cached per
 * `recordHash` for `ATTESTATION_CACHE_TTL_SECONDS` (default 120s) using
 * Next's `unstable_cache`, so repeat views within the TTL window hit the
 * data cache instead of RPC. Entries are tagged `attestation:<recordHash>`
 * so a future "new attestation recorded" signal can call
 * `revalidateTag(\`attestation:${recordHash}\`)` to invalidate proactively.
 *
 * The public function signature is unchanged, so no caller needs to change.
 */

/** Fixture hash for local dev/demo only — not a real record's hash. */
export const DEMO_VERIFIED_RECORD_HASH = "a".repeat(64);

/**
 * Maximum milliseconds to wait for a Soroban RPC response before treating
 * the attestation lookup as a failure.
 *
 * Callers (e.g. the public card page) should treat a rejection from
 * `getAttestation` as "verification status unavailable" rather than a
 * hard error — the card must still render the emergency data.
 */
export const ATTESTATION_TIMEOUT_MS = 2000;

/**
 * How long a cached attestation lookup is considered fresh, in seconds.
 * Configurable via env so it can be tuned without a code change.
 * Default: 120s.
 */
export const ATTESTATION_CACHE_TTL_SECONDS = Number(
  process.env.ATTESTATION_CACHE_TTL_SECONDS ?? 120,
);

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

/**
 * Uncached lookup — original implementation, unchanged in behavior.
 * `getAttestation` wraps this with a per-recordHash cache.
 */
async function fetchAttestationUncached(
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
 * Cached lookup, keyed by `recordHash`. Each distinct hash gets its own
 * cache entry, so results never leak across different records.
 */
export async function getAttestation(
  recordHash: string,
): Promise<Attestation | null> {
  const cached = unstable_cache(
    async (hash: string) => fetchAttestationUncached(hash),
    ["attestation", recordHash],
    {
      revalidate: ATTESTATION_CACHE_TTL_SECONDS,
      tags: ["attestation", `attestation:${recordHash}`],
    },
  );

  return cached(recordHash);
}

// TODO(#17 follow-up): once contract writes emit a "new attestation
// recorded" signal, call revalidateTag(`attestation:${recordHash}`)
// immediately after that signal for faster-than-TTL invalidation.

/**
 * The contract returns the `Attestation` struct
 * ({ record_hash, attester, timestamp }). Decoding is defensive: we don't
 * assume the exact SCVal key casing, and we validate types so a malformed
 * on-chain value can't quietly poison the verified indicator.
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
  if (typeof value === "bigint") {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : null;
  }
  return null;
}