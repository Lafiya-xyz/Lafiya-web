import vectors from "@/contracts/record-canonicalization-v1.json";
import {
  canonicalizeEmergencyRecord,
  computeRevisionCommitment,
} from "./canonicalization";

import { describe, expect, it } from "vitest";

describe("record canonicalization v1", () => {
  for (const vector of vectors.vectors) {
    it(vector.name, () => {
      expect(canonicalizeEmergencyRecord(vector.input as never)).toBe(
        vector.canonical,
      );
      expect(
        computeRevisionCommitment(vector.input as never, vector.secretHex),
      ).toBe(vector.commitment);
    });
  }

  it("is invariant to list ordering and presentation-only fields", () => {
    const base = vectors.vectors[0].input;
    const changed = {
      ...base,
      photo_url: "https://example.invalid/other.jpg",
      date_of_birth: "2000-01-01",
      allergies: [...base.allergies].reverse(),
    };
    expect(
      computeRevisionCommitment(changed as never, vectors.vectors[0].secretHex),
    ).toBe(vectors.vectors[0].commitment);
  });

  it("changes for every committed field", () => {
    const base = vectors.vectors[0].input;
    for (const [field, value] of [
      ["name", "Different"],
      ["blood_group", "A+"],
      ["genotype", "AA"],
      ["language", "Yoruba"],
    ] as const) {
      expect(
        computeRevisionCommitment(
          { ...base, [field]: value } as never,
          vectors.vectors[0].secretHex,
        ),
      ).not.toBe(vectors.vectors[0].commitment);
    }
  });
});
