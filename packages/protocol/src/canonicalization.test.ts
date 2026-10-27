import { describe, expect, it } from "vitest";
import vectors from "./test-vectors/record-canonicalization-v1.json" assert { type: "json" };
import {
  canonicalizeEmergencyRecord,
  computeRevisionCommitment,
  computeRevisionCommitmentSync,
  normalizeEmergencyRecord,
} from "./canonicalization.js";
import type { EmergencyRecordData } from "./types.js";

// ── Test vector coverage ──────────────────────────────────────────────────────

describe("record canonicalization v1 test vectors", () => {
  for (const vector of vectors.vectors) {
    it(vector.name, async () => {
      const input = vector.input as EmergencyRecordData;
      expect(canonicalizeEmergencyRecord(input)).toBe(vector.canonical);
      expect(await computeRevisionCommitment(input, vector.secretHex)).toBe(
        vector.commitment,
      );
      // Sync variant must match async
      expect(computeRevisionCommitmentSync(input, vector.secretHex)).toBe(
        vector.commitment,
      );
    });
  }
});

// ── Canonicalization invariants ───────────────────────────────────────────────

describe("canonicalizeEmergencyRecord", () => {
  const base: EmergencyRecordData = {
    name: "Amina Yusuf",
    date_of_birth: "1998-04-03",
    photo_url: "https://example.invalid/avatar.jpg",
    language: "Hausa",
    blood_group: "O+",
    genotype: "AS",
    allergies: ["Latex", "Penicillin"],
    medications: ["Insulin"],
    chronic_conditions: ["Asthma"],
    emergency_contacts: [
      { name: "Halima Yusuf", phone: "+2348012345678", relationship: "Mother" },
    ],
  };

  it("is invariant to date_of_birth and photo_url changes", () => {
    const changed: EmergencyRecordData = {
      ...base,
      date_of_birth: "2000-01-01",
      photo_url: "https://example.invalid/other.jpg",
    };
    expect(canonicalizeEmergencyRecord(base)).toBe(
      canonicalizeEmergencyRecord(changed),
    );
  });

  it("is invariant to allergy list order", () => {
    const reversed: EmergencyRecordData = {
      ...base,
      allergies: ["Penicillin", "Latex"],
    };
    expect(canonicalizeEmergencyRecord(base)).toBe(
      canonicalizeEmergencyRecord(reversed),
    );
  });

  it("changes when a committed medical field changes", async () => {
    const cases: Array<[keyof EmergencyRecordData, unknown]> = [
      ["name", "Different Name"],
      ["blood_group", "A+"],
      ["genotype", "AA"],
      ["language", "Yoruba"],
    ];
    const secret = "1".repeat(64);
    const baseCommitment = await computeRevisionCommitment(base, secret);
    for (const [field, value] of cases) {
      const changed = { ...base, [field]: value } as EmergencyRecordData;
      expect(await computeRevisionCommitment(changed, secret)).not.toBe(
        baseCommitment,
      );
    }
  });

  it("normalizes NFC vs NFD to the same canonical form", () => {
    const nfc = base;
    const nfd: EmergencyRecordData = { ...base, name: "Amina Yusuf".normalize("NFD") };
    expect(canonicalizeEmergencyRecord(nfc)).toBe(
      canonicalizeEmergencyRecord(nfd),
    );
  });
});

// ── normalizeEmergencyRecord ──────────────────────────────────────────────────

describe("normalizeEmergencyRecord", () => {
  it("trims whitespace and normalizes text", () => {
    const raw: EmergencyRecordData = {
      name: "  Amina   Yusuf ",
      date_of_birth: null,
      photo_url: null,
      language: " Hausa ",
      blood_group: "O+",
      genotype: "AS",
      allergies: [],
      medications: [],
      chronic_conditions: [],
      emergency_contacts: [],
    };
    const result = normalizeEmergencyRecord(raw);
    expect(result.name).toBe("Amina Yusuf");
    expect(result.language).toBe("Hausa");
  });

  it("deduplicates and sorts allergies", () => {
    const raw: EmergencyRecordData = {
      name: "Test",
      date_of_birth: null,
      photo_url: null,
      language: null,
      blood_group: "O+",
      genotype: "AA",
      allergies: ["Penicillin", " Latex ", "Penicillin"],
      medications: [],
      chronic_conditions: [],
      emergency_contacts: [],
    };
    const result = normalizeEmergencyRecord(raw);
    expect(result.allergies).toEqual(["Latex", "Penicillin"]);
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe("computeRevisionCommitment error handling", () => {
  const dummy: EmergencyRecordData = {
    name: "Test",
    date_of_birth: null,
    photo_url: null,
    language: null,
    blood_group: "O+",
    genotype: "AA",
    allergies: [],
    medications: [],
    chronic_conditions: [],
    emergency_contacts: [],
  };

  it("rejects a non-hex secret", async () => {
    await expect(
      computeRevisionCommitment(dummy, "not-hex"),
    ).rejects.toThrow("INVALID_RECORD_SECRET");
  });

  it("rejects a secret that is too short", async () => {
    await expect(
      computeRevisionCommitment(dummy, "ab"),
    ).rejects.toThrow("INVALID_RECORD_SECRET");
  });

  it("rejects a 63-character hex secret (one short)", async () => {
    await expect(
      computeRevisionCommitment(dummy, "a".repeat(63)),
    ).rejects.toThrow("INVALID_RECORD_SECRET");
  });
});
