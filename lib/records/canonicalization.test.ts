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

  it("produces identical output for Unicode-equivalent but differently-encoded representations (NFC vs NFD)", () => {
    const base = vectors.vectors[0].input;
    
    // "café" in NFC form (precomposed)
    const nfcName = "café";
    // "café" in NFD form (decomposed)
    const nfdName = "cafe\u0301";
    
    expect(nfcName).not.toBe(nfdName); // Verify they're different byte sequences
    expect(nfcName).toBe(nfdName.normalize("NFC")); // But equivalent
    
    const recordWithNFC = { ...base, name: nfcName } as never;
    const recordWithNFD = { ...base, name: nfdName } as never;
    
    // Both should produce identical canonicalization
    expect(canonicalizeEmergencyRecord(recordWithNFC)).toBe(
      canonicalizeEmergencyRecord(recordWithNFD),
    );
    
    // And identical commitments
    expect(computeRevisionCommitment(recordWithNFC, vectors.vectors[0].secretHex)).toBe(
      computeRevisionCommitment(recordWithNFD, vectors.vectors[0].secretHex),
    );
  });

  it("handles accented characters in emergency contact relationship field", () => {
    const base = vectors.vectors[0].input;
    
    // Create two variants with accented relationship values
    // "mère" (mother in French) in NFC vs NFD
    const nfcRelationship = "mère";
    const nfdRelationship = "mere\u0300";
    
    const contactWithNFC = {
      name: "John Doe",
      phone: "+234801234567",
      relationship: nfcRelationship,
    };
    
    const contactWithNFD = {
      name: "John Doe",
      phone: "+234801234567",
      relationship: nfdRelationship,
    };
    
    const recordWithNFC = {
      ...base,
      emergency_contacts: [contactWithNFC],
    } as never;
    
    const recordWithNFD = {
      ...base,
      emergency_contacts: [contactWithNFD],
    } as never;
    
    // Both should produce identical canonicalization
    expect(canonicalizeEmergencyRecord(recordWithNFC)).toBe(
      canonicalizeEmergencyRecord(recordWithNFD),
    );
    
    // And identical commitments
    expect(computeRevisionCommitment(recordWithNFC, vectors.vectors[0].secretHex)).toBe(
      computeRevisionCommitment(recordWithNFD, vectors.vectors[0].secretHex),
    );
  });

  it("handles emoji and other complex Unicode in patient names", () => {
    const base = vectors.vectors[0].input;
    
    // Test with emoji in name
    const nameWithEmoji = "John Doe 👨‍⚕️";
    
    const recordWithEmoji = { ...base, name: nameWithEmoji } as never;
    
    // Should normalize emoji sequences correctly
    const canonical = canonicalizeEmergencyRecord(recordWithEmoji);
    expect(canonical).toBeDefined();
    expect(canonical).toContain("John Doe");
  });
});
