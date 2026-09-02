import { describe, expect, it } from "vitest";

import { mockUnstableCache } from "@/tests/fixtures/next-cache";

void mockUnstableCache;

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
