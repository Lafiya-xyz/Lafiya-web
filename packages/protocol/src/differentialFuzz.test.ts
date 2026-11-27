import { describe, expect, it } from "vitest";

import { canonicalizeEmergencyRecordVerifier } from "@/lib/records/canonicalization";

import { runDifferentialFuzz } from "./differentialFuzz.js";

describe("differential fuzz (issue #958)", () => {
  it("protocol and verifier agree on generated records", () => {
    const report = runDifferentialFuzz({
      seed: 958,
      cases: 200,
      candidate: canonicalizeEmergencyRecordVerifier,
    });
    expect(report.divergences).toEqual([]);
  });

  it("is deterministic for a given seed", () => {
    const candidate = canonicalizeEmergencyRecordVerifier;
    const first = runDifferentialFuzz({ seed: 7, cases: 20, candidate });
    const second = runDifferentialFuzz({ seed: 7, cases: 20, candidate });
    expect(second).toEqual(first);
  });
});
