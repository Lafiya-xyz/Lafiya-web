import { describe, expect, it, vi, beforeEach } from "vitest";

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

import { DEMO_VERIFIED_RECORD_HASH, getAttestation } from "./attestation";

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