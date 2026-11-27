/**
 * Differential fuzzing of record canonicalization (issue #958).
 *
 * Generates random emergency records and compares the canonical form produced
 * by two independent implementations of the v1 contract:
 *
 *   - `@lafiya/protocol` (this package) — the reference implementation;
 *   - the web app's `lib/records/canonicalization.ts` — the verifier-side
 *     implementation used by the attestation pipeline.
 *
 * The generator is seeded so a divergence is reproducible from the seed alone.
 * Divergences are returned as test-vector-shaped objects; the nightly job
 * (`scripts/differential-fuzz.mjs`) persists them under
 * `contracts/differential-vectors/` and opens a cross-repo issue.
 *
 * No PHI: every generated value is synthetic.
 */

import { canonicalizeEmergencyRecord } from "./canonicalization.js";
import type {
  BloodGroup,
  EmergencyContact,
  EmergencyRecordData,
  Genotype,
} from "./types.js";

export type DifferentialDivergence = {
  /** Deterministic vector name, e.g. `differential-seed-42-case-7`. */
  name: string;
  seed: number;
  caseIndex: number;
  input: EmergencyRecordData;
  /** Canonical form from `@lafiya/protocol`. */
  expected: string;
  /** Canonical form from the verifier-side implementation. */
  actual: string;
};

export type DifferentialFuzzReport = {
  seed: number;
  cases: number;
  divergences: DifferentialDivergence[];
};

export type DifferentialFuzzOptions = {
  seed?: number;
  cases?: number;
  /** Verifier-side canonicalizer under test. */
  candidate: (data: EmergencyRecordData) => string;
};

// ── Deterministic PRNG ────────────────────────────────────────────────────────

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Record generator ──────────────────────────────────────────────────────────

const BLOOD_GROUPS: BloodGroup[] = [
  "A+",
  "A-",
  "B+",
  "B-",
  "AB+",
  "AB-",
  "O+",
  "O-",
  "unknown",
];

const GENOTYPES: Genotype[] = ["AA", "AS", "SS", "SC", "AC", "unknown"];

const WORDS = [
  "Amina",
  "Yusuf",
  "Chinedu",
  "Okafor",
  "Halima",
  "Bello",
  "Ngozi",
  "Adeyemi",
  "Penicillin",
  "Latex",
  "Insulin",
  "Asthma",
  "Mother",
  "Brother",
  "Hausa",
  "Yoruba",
  "Igbo",
  "e\u0301",
  "\u00e9",
  "ß",
  "İstanbul",
  "  ",
  "\t",
  "\u00a0",
  "O+",
  "unknown",
];

const PHONE_SHAPES = [
  "0801 234 5678",
  "08012345678",
  "+2348012345678",
  "+234 801 234 5678",
  "2348012345678",
  "0801-234-5678",
  "not a phone",
  "  +234 802 345 6789  ",
  "",
  "0801\t234\t5678",
];

const DATE_SHAPES = [null, "1998-04-03", "2000-01-01", "", "not-a-date"];

const URL_SHAPES = [
  null,
  "https://example.invalid/avatar.jpg",
  "  https://example.invalid/other.jpg  ",
  "",
];

function pick<T>(rand: () => number, values: readonly T[]): T {
  return values[Math.floor(rand() * values.length)];
}

function randomText(rand: () => number): string {
  const parts = 1 + Math.floor(rand() * 3);
  const words: string[] = [];
  for (let i = 0; i < parts; i += 1) words.push(pick(rand, WORDS));
  const separator = pick(rand, [" ", "  ", "\t", " \u00a0 "]);
  const text = words.join(separator);
  return pick(rand, [text, ` ${text} `, `${text}  `, text.toUpperCase()]);
}

function randomList(rand: () => number): string[] {
  const length = Math.floor(rand() * 4);
  const values: string[] = [];
  for (let i = 0; i < length; i += 1) values.push(randomText(rand));
  return values;
}

/** Generates one synthetic emergency record from the given PRNG. */
export function generateRecord(rand: () => number): EmergencyRecordData {
  const contactCount = Math.floor(rand() * 3);
  const emergency_contacts: EmergencyContact[] = [];
  for (let i = 0; i < contactCount; i += 1) {
    emergency_contacts.push({
      name: randomText(rand),
      phone: pick(rand, PHONE_SHAPES),
      relationship: randomText(rand),
    });
  }
  return {
    name: randomText(rand),
    date_of_birth: pick(rand, DATE_SHAPES),
    photo_url: pick(rand, URL_SHAPES),
    language: pick(rand, [null, randomText(rand), "", "  "]),
    blood_group: pick(rand, BLOOD_GROUPS),
    genotype: pick(rand, GENOTYPES),
    allergies: randomList(rand),
    medications: randomList(rand),
    chronic_conditions: randomList(rand),
    emergency_contacts,
  };
}

// ── Differential runner ───────────────────────────────────────────────────────

/**
 * Runs `cases` generated records through both implementations and returns
 * every divergence. Deterministic for a given seed.
 */
export function runDifferentialFuzz({
  seed = 958,
  cases = 500,
  candidate,
}: DifferentialFuzzOptions): DifferentialFuzzReport {
  const rand = mulberry32(seed);
  const divergences: DifferentialDivergence[] = [];
  for (let caseIndex = 0; caseIndex < cases; caseIndex += 1) {
    const input = generateRecord(rand);
    const expected = canonicalizeEmergencyRecord(input);
    const actual = candidate(input);
    if (expected !== actual) {
      divergences.push({
        name: `differential-seed-${seed}-case-${caseIndex}`,
        seed,
        caseIndex,
        input,
        expected,
        actual,
      });
    }
  }
  return { seed, cases, divergences };
}
