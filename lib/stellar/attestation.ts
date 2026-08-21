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
 * The in-memory fixture can run only when `ATTESTATION_MOCK_MODE=true` (tests
 * default this explicitly). A missing contract is an unavailable verification
 * service, never a convincing production verification.
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
 * Circuit breaker states for protecting against cascading RPC failures.
 * CLOSED: normal operation, requests pass through
 * OPEN: fast-fail mode, no RPC attempts
 * HALF-OPEN: one trial request allowed to test recovery
 */
type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";

/**
 * Circuit breaker configuration.
 */
interface CircuitBreakerConfig {
  /** Number of consecutive failures before tripping to OPEN */
  failureThreshold: number;
  /** Cooldown period in milliseconds before attempting HALF-OPEN */
  cooldownMs: number;
}

/**
 * Circuit breaker implementation following the Release It! pattern.
 * Protects against cascading failures and hung RPC endpoints.
 *
 * Deployment model: Per-instance singleton for Vercel serverless.
 * This is acceptable because:
 * 1. Vercel reuses warm instances for concurrent requests within the same region
 * 2. Each instance independently protects its own request flow
 * 3. The breaker provides meaningful protection even if not fully distributed:
 *    - During an outage, each instance will independently trip after 3 failures
 *    - Fast-fail behavior prevents any single instance from hanging
 *    - Cooldown ensures instances don't hammer a degraded endpoint
 * 4. Adding Redis/distributed state would introduce infrastructure complexity
 *    disproportionate to the benefit for this read-only, cache-backed operation
 * 5. The primary goal is latency protection, not perfect coordination across instances
 *
 * Exported for testing.
 */
export class CircuitBreaker {
  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  /**
   * Execute an operation through the circuit breaker.
   * Fast-fails if OPEN, tracks failures, and manages state transitions.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "OPEN") {
      if (this.shouldAttemptReset()) {
        this.state = "HALF-OPEN";
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Check if enough time has passed to attempt a reset to HALF-OPEN.
   */
  private shouldAttemptReset(): boolean {
    if (this.lastFailureTime === null) return false;
    const elapsed = Date.now() - this.lastFailureTime;
    return elapsed >= this.config.cooldownMs;
  }

  /**
   * Handle successful operation - reset failure count and close breaker.
   */
  private onSuccess(): void {
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.state = "CLOSED";
  }

  /**
   * Handle failed operation - increment count and potentially trip breaker.
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.config.failureThreshold) {
      this.state = "OPEN";
    }
  }

  /**
   * Reset the breaker to CLOSED state (for testing or manual recovery).
   */
  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  /**
   * Get current state (for testing/monitoring).
   */
  getState(): CircuitState {
    return this.state;
  }
}

/**
 * Circuit breaker instance for attestation RPC calls.
 * Trips after 3 consecutive failures, 30-second cooldown.
 */
export const attestationBreaker = new CircuitBreaker({
  failureThreshold: 3,
  cooldownMs: 30000,
});

/**
 * Wrap an async operation with a hard timeout.
 * Rejects with "Attestation RPC timeout" if the operation doesn't complete
 * within ATTESTATION_TIMEOUT_MS.
 *
 * Exported for testing.
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Attestation RPC timeout")), timeoutMs);
  });

  return Promise.race([operation(), timeoutPromise]);
}

/**
 * How long a cached attestation lookup is considered fresh, in seconds.
 * Configurable via env so it can be tuned without a code change.
 * Default: 120s.
 */
export const ATTESTATION_CACHE_TTL_SECONDS = Number(
  process.env.ATTESTATION_CACHE_TTL_SECONDS ?? 120,
);

const MOCK_ATTESTATIONS = new Map<string, Attestation>([
  [
    DEMO_VERIFIED_RECORD_HASH,
    {
      recordHash: DEMO_VERIFIED_RECORD_HASH,
      attester: "GDEMOATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      timestamp: 1735689600,
    },
  ],
]);

// simulateTransaction needs a source account, but since we never submit the
// transaction it's just a placeholder — any well-formed account works. Built
// lazily (only on the real-RPC path) so importing this module doesn't require
// a valid account and the local-dev mock fallback stays side-effect free.
function simulationSource() {
  return new Account(Keypair.random().publicKey(), "0");
}

/**
 * Uncached lookup with circuit breaker and timeout protection.
 */
async function fetchAttestationUncached(
  recordHash: string,
): Promise<Attestation | null> {
  return attestationBreaker.execute(async () => {
    // Fixture mode is explicit and production configuration rejects it.
    if (!serverEnv.ATTESTATION_CONTRACT_ID) {
      if (serverEnv.ATTESTATION_MOCK_MODE === "true") {
        return MOCK_ATTESTATIONS.get(recordHash) ?? null;
      }
      throw new Error("ATTESTATION_CONTRACT_NOT_CONFIGURED");
    }

    return withTimeout(async () => {
      const server = new rpc.Server(serverEnv.SOROBAN_RPC_URL);
      const contract = new Contract(serverEnv.ATTESTATION_CONTRACT_ID!);

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
    }, ATTESTATION_TIMEOUT_MS);
  });
}

/**
 * Simple in-memory memoization fallback for when unstable_cache is unavailable.
 * Used outside full Next.js request context (tests, scripts, etc.).
 */
const memoCache = new Map<string, Promise<Attestation | null>>();
const memoTimestamps = new Map<string, number>();

/**
 * Memoized lookup with TTL, used as fallback when unstable_cache context is missing.
 */
async function getAttestationMemoized(
  recordHash: string,
): Promise<Attestation | null> {
  const now = Date.now();
  const cacheKey = recordHash;
  const ttlMs = ATTESTATION_CACHE_TTL_SECONDS * 1000;

  const cachedTimestamp = memoTimestamps.get(cacheKey);
  if (cachedTimestamp && now - cachedTimestamp < ttlMs) {
    const cachedPromise = memoCache.get(cacheKey);
    if (cachedPromise) {
      return cachedPromise;
    }
  }

  const promise = fetchAttestationUncached(recordHash);
  memoCache.set(cacheKey, promise);
  memoTimestamps.set(cacheKey, now);

  return promise;
}

/**
 * Cached lookup, keyed by `recordHash`. Each distinct hash gets its own
 * cache entry, so results never leak across different records.
 *
 * The cache wrapper is constructed once at module scope to avoid:
 * 1. Creating a new cache on every call (performance issue)
 * 2. "incrementalCache missing" errors outside full Next.js request context
 *
 * When unstable_cache is unavailable (non-request context), falls back to
 * process-local memoization with TTL.
 */
const getCachedAttestation = (() => {
  try {
    // Attempt to create the unstable_cache wrapper at module scope
    return unstable_cache(
      async (hash: string) => fetchAttestationUncached(hash),
      ["attestation"],
      {
        revalidate: ATTESTATION_CACHE_TTL_SECONDS,
        tags: ["attestation"],
      },
    );
  } catch {
    // If unstable_cache fails (missing incremental cache context),
    // fall back to simple memoization
    return getAttestationMemoized;
  }
})();

export async function getAttestation(
  recordHash: string,
): Promise<Attestation | null> {
  return getCachedAttestation(recordHash);
}

// TODO(#17 follow-up): once contract writes emit a "new attestation
// recorded" signal, call revalidateTag(`attestation:${recordHash}`)
// immediately after that signal for faster-than-TTL invalidation.

/**
 * Validate that an attestation for the given record hash is present, not
 * expired, and not revoked. Lives here (not lib/attestation/recordHash.ts)
 * so recordHash.ts stays a pure, Stellar-SDK-free canonicalization module —
 * see issues/issue-03-record-hash-commitment-scheme.md's note on this
 * cross-cutting concern.
 */
export async function validateAttestation(
  recordHash: string,
): Promise<boolean> {
  const att = await getAttestation(recordHash);
  if (!att) return false;
  const now = Math.floor(Date.now() / 1000);
  if (att.revoked) return false;
  if (att.expiry && att.expiry < now) return false;
  return true;
}

/**
 * The contract returns the `Attestation` struct
 * ({ record_hash, attester, timestamp, revoked, expiry }). Decoding is defensive:
 * we don't assume the exact SCVal key casing, and we validate types so a malformed
 * on-chain value can't quietly poison the verified indicator.
 *
 * Option<T> fields (revoked, expiry) are decoded as:
 * - Some(value): the value itself (boolean for revoked, bigint for expiry)
 * - None: undefined
 *
 * Exported for testing.
 */
export function decodeAttestation(
  value: unknown,
  recordHash: string,
): Attestation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;

  const attester = extractAddress(raw.attester);
  const timestamp = extractTimestamp(raw.timestamp);
  const revoked = extractOptionalBool(raw.revoked);
  const expiry = extractOptionalU64(raw.expiry);

  if (typeof attester !== "string" || typeof timestamp !== "number") {
    return null;
  }

  const attestation: Attestation = {
    recordHash,
    attester,
    timestamp,
  };

  if (revoked !== undefined) {
    attestation.revoked = revoked;
  }
  if (expiry !== undefined) {
    attestation.expiry = expiry;
  }

  return attestation;
}

function extractAddress(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof (value as { toString?: () => string }).toString === "function"
  ) {
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

/**
 * Extract an optional boolean from Option<bool>.
 * Returns the boolean if Some, undefined if None/invalid.
 */
function extractOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  return undefined;
}

/**
 * Extract an optional u64 from Option<u64>.
 * Returns the number if Some, undefined if None/invalid.
 */
function extractOptionalU64(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : undefined;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  return undefined;
}
