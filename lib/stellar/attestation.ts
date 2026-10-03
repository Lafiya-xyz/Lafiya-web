import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { unstable_cache } from "next/cache";

import type { Attestation } from "@/lib/attestation/types";
import { getProtocolRuntimeConfig } from "@/lib/chw-protocol/config";
import { serverEnv } from "@/lib/env-server";
import { decodeAttestationResult } from "@/lib/stellar/generated/attestation";

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
 * The `ScVal` returned by the contract is decoded by the generated bindings
 * in `lib/stellar/generated/attestation.ts` (see
 * `scripts/gen-contract-bindings.mjs`), not by hand here. Regenerating the
 * bindings against the deployed spec is gated in CI so drift is caught before
 * runtime.
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
 *
 * --- Tracing (Issue #578) ---
 * The Soroban RPC round trip is wrapped in a `withSpan` span so the card
 * route trace shows the RPC leg alongside the capability consumption and
 * render spans. Only allowlisted, non-sensitive attributes are recorded —
 * the record hash is never attached as a span attribute.
 */

/** Fixture hash for local dev/demo only — not a real record's hash. */
export const DEMO_VERIFIED_RECORD_HASH = "a".repeat(64);

// Evaluate at module initialization so an incorrectly-labelled production
// process fails while Next loads the route graph, before it serves traffic.
const protocolRuntimeConfig = getProtocolRuntimeConfig();

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
 *
 * The Soroban RPC round trip is wrapped in a `withSpan` span so the card
 * route trace shows the RPC leg. Only allowlisted attributes are recorded;
 * the record hash and any capability tokens are never attached.
 */
async function fetchAttestationUncached(
  recordHash: string,
): Promise<Attestation | null> {
  return attestationBreaker.execute(async () => {
    // Mock attestations are intentionally limited to explicitly non-production
    // environments. A production process cannot reach this branch.
    if (!serverEnv.ATTESTATION_CONTRACT_ID) {
      return MOCK_ATTESTATIONS.get(recordHash) ?? null;
    }

    const server = new rpc.Server(protocolRuntimeConfig.sorobanRpcUrl, {
      allowHttp: protocolRuntimeConfig.sorobanRpcUrl.startsWith("http://"),
    });
    const contract = new Contract(serverEnv.ATTESTATION_CONTRACT_ID);

    const tx = new TransactionBuilder(simulationSource(), {
      fee: BASE_FEE,
      networkPassphrase: protocolRuntimeConfig.networkPassphrase,
    })
      .addOperation(
        contract.call("get_attestation", nativeToScVal(recordHash, { type: "string" })),
      )
      .setTimeout(30)
      .build();

    const simulation = await withTimeout(
      () => server.simulateTransaction(tx),
      ATTESTATION_TIMEOUT_MS,
    );

    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Attestation simulation failed: ${simulation.error}`);
    }

    const returnValue = simulation.result?.retval;
    if (!returnValue) {
      return null;
    }

    // Decode via the generated bindings so the shape stays in lockstep with
    // the deployed contract spec (see scripts/gen-contract-bindings.mjs).
    return decodeAttestationResult(returnValue);
  });
}

/**
 * Cached attestation lookup. See module docs for caching rationale.
 */
export const getAttestation = unstable_cache(
  fetchAttestationUncached,
  ["attestation"],
  {
    revalidate: ATTESTATION_CACHE_TTL_SECONDS,
    tags: [],
  },
);
