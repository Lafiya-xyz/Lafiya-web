import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockUnstableCache } from "@/tests/fixtures/next-cache";

// The shared mock models TTL/`revalidate` behavior, not just "cache forever
// keyed by args" — a cache mock that never expires can't exercise expiry
// behavior at all, which is exactly the gap this file's TTL tests below
// close.
void mockUnstableCache;

import {
  ATTESTATION_CACHE_TTL_SECONDS,
  DEMO_VERIFIED_RECORD_HASH,
  attestationBreaker,
  getAttestation,
} from "./attestation";

describe("getAttestation caching", () => {
  it("returns a consistent result for repeated calls with the same recordHash", async () => {
    const first = await getAttestation(DEMO_VERIFIED_RECORD_HASH);
    const second = await getAttestation(DEMO_VERIFIED_RECORD_HASH);
    expect(first).toEqual(second);
  });

  it("does not leak cached results across different recordHashes", async () => {
    const known = await getAttestation(DEMO_VERIFIED_RECORD_HASH);
    const unknown = await getAttestation("b".repeat(64));
    expect(known).not.toBeNull();
    expect(unknown).toBeNull();
  });
});

describe("getAttestation cache TTL expiry (docs/attestation-caching-perf.md)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a cached entry as-is for repeat lookups within the TTL window", async () => {
    // Unique hash per test so cache state from other tests in this file
    // (which share the module-scoped cache instance) can't interfere.
    const recordHash = "c".repeat(64);
    const executeSpy = vi.spyOn(attestationBreaker, "execute");
    executeSpy.mockClear();

    await getAttestation(recordHash);
    vi.advanceTimersByTime(ATTESTATION_CACHE_TTL_SECONDS * 1000 - 1_000);
    await getAttestation(recordHash);

    // A second lookup still inside the TTL window must be served from the
    // cache, not trigger a second underlying attestation fetch.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    executeSpy.mockRestore();
  });

  it("refreshes (re-fetches) a cached entry once its TTL has elapsed, rather than serving it indefinitely", async () => {
    const recordHash = "d".repeat(64);
    const executeSpy = vi.spyOn(attestationBreaker, "execute");
    executeSpy.mockClear();

    await getAttestation(recordHash);
    vi.advanceTimersByTime(ATTESTATION_CACHE_TTL_SECONDS * 1000 + 1_000);
    await getAttestation(recordHash);

    // Once the TTL has elapsed, the "verified" status must be re-checked —
    // a stale cached entry must never be served forever.
    expect(executeSpy).toHaveBeenCalledTimes(2);
    executeSpy.mockRestore();
  });
});
