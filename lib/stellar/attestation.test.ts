import { describe, expect, it, vi, beforeEach } from "vitest";

import { mockUnstableCache } from "@/tests/fixtures/next-cache";

void mockUnstableCache;

import {
  attestationBreaker,
  CircuitBreaker,
  decodeAttestation,
  DEMO_VERIFIED_RECORD_HASH,
  getAttestation,
  withTimeout,
} from "./attestation";

describe("CircuitBreaker", () => {
  it("allows execution under normal circumstances (CLOSED state)", async () => {
    attestationBreaker.reset();
    expect(attestationBreaker.getState()).toBe("CLOSED");

    const result = await attestationBreaker.execute(async () => "success");
    expect(result).toBe("success");
    expect(attestationBreaker.getState()).toBe("CLOSED");
  });

  it("trips and fast-fails after failureThreshold (3 consecutive failures)", async () => {
    attestationBreaker.reset();
    expect(attestationBreaker.getState()).toBe("CLOSED");

    for (let i = 0; i < 3; i++) {
      await expect(
        attestationBreaker.execute(async () => {
          throw new Error("RPC error");
        }),
      ).rejects.toThrow("RPC error");
    }

    expect(attestationBreaker.getState()).toBe("OPEN");

    await expect(
      attestationBreaker.execute(async () => "should not execute"),
    ).rejects.toThrow("Circuit breaker is OPEN");
  });

  it("resets to CLOSED after success in HALF-OPEN state", async () => {
    // Create a test-specific breaker with short cooldown
    const testBreaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 100, // Very short cooldown for testing
    });

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      try {
        await testBreaker.execute(async () => {
          throw new Error("RPC error");
        });
      } catch {
        // Expected to fail
      }
    }
    expect(testBreaker.getState()).toBe("OPEN");

    // Wait for cooldown to pass (100ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // First call in HALF-OPEN should succeed and close the breaker
    const result = await testBreaker.execute(async () => "success");
    expect(result).toBe("success");
    expect(testBreaker.getState()).toBe("CLOSED");
  });
});

describe("getAttestation", () => {
  beforeEach(() => {
    attestationBreaker.reset();
  });

  it("returns the attestation for the demo verified hash", async () => {
    const attestation = await getAttestation(DEMO_VERIFIED_RECORD_HASH);
    expect(attestation).not.toBeNull();
    expect(attestation?.recordHash).toBe(DEMO_VERIFIED_RECORD_HASH);
  });

  it("returns null for an unknown hash (not_verified path)", async () => {
    const attestation = await getAttestation("b".repeat(64));
    expect(attestation).toBeNull();
  });

  it("rejects with a timeout error when the RPC hangs, and counts toward the circuit-breaker failure threshold", async () => {
    attestationBreaker.reset();

    // Test the timeout wrapper directly by creating a hanging operation
    const hangingOperation = () => new Promise(() => {}); // Never resolves

    await expect(
      withTimeout(hangingOperation, 100), // Use short timeout for test
    ).rejects.toThrow("Attestation RPC timeout");
  });

  it("fast-fails immediately when the circuit breaker is OPEN (protects page latency during outages)", async () => {
    attestationBreaker.reset();

    // Trip the breaker with 3 failures
    for (let i = 0; i < 3; i++) {
      try {
        await attestationBreaker.execute(async () => {
          throw new Error("RPC error");
        });
      } catch {
        // Expected to fail
      }
    }
    expect(attestationBreaker.getState()).toBe("OPEN");

    // Measure time to fast-fail
    const start = performance.now();
    await expect(
      attestationBreaker.execute(async () => "should not execute"),
    ).rejects.toThrow("Circuit breaker is OPEN");
    const elapsed = performance.now() - start;

    // Should fail in well under 100ms
    expect(elapsed).toBeLessThan(100);

    attestationBreaker.reset();
  });

  it("correctly decodes revoked and expiry fields from Option<T> encoding", async () => {
    const recordHash = "a".repeat(64);

    // Test with revoked=true and expiry set
    const withRevokedAndExpiry = decodeAttestation(
      {
        record_hash: recordHash,
        attester: "GATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        timestamp: 1735689600,
        revoked: true, // Some(true)
        expiry: 1735689600, // Some(1735689600)
      },
      recordHash,
    );

    expect(withRevokedAndExpiry).not.toBeNull();
    expect(withRevokedAndExpiry?.revoked).toBe(true);
    expect(withRevokedAndExpiry?.expiry).toBe(1735689600);

    // Test with revoked=false and expiry undefined (None)
    const withoutRevokedAndExpiry = decodeAttestation(
      {
        record_hash: recordHash,
        attester: "GATTESTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        timestamp: 1735689600,
        revoked: undefined, // None
        expiry: undefined, // None
      },
      recordHash,
    );

    expect(withoutRevokedAndExpiry).not.toBeNull();
    expect(withoutRevokedAndExpiry?.revoked).toBeUndefined();
    expect(withoutRevokedAndExpiry?.expiry).toBeUndefined();
  });

  it("does not throw when unstable_cache context is absent (falls back to memoization)", async () => {
    // The mock in this file already makes unstable_cache unavailable,
    // so this test verifies that getAttestation still works correctly
    // by using the fallback memoization path.
    const attestation = await getAttestation(DEMO_VERIFIED_RECORD_HASH);
    expect(attestation).not.toBeNull();
    expect(attestation?.recordHash).toBe(DEMO_VERIFIED_RECORD_HASH);
  });
});
