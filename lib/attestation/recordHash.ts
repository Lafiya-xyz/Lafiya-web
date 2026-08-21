import type { ProfileRow } from "@/lib/supabase/types";
import { getAttestation } from "@/lib/stellar/attestation";
import {
  computeRevisionCommitment,
  type EmergencyRecordData,
} from "@/lib/records/canonicalization";

/**
 * The subset of card fields that feed the commitment. `age` is deliberately
 * excluded: EmergencyCardRow.age is derived live from date_of_birth
 * (`extract(year from age(dob))` in get_emergency_card()) and would
 * otherwise silently change every year on the patient's birthday, which
 * would falsely flag an unedited profile as "stale" (see
 * app/(auth)/profile/page.tsx). `photo_url` is excluded for the same
 * cosmetic-not-medical reason it always was.
 *
 * EmergencyCardRow and ProfileRow both already use these exact field
 * names/types for this subset, so either row type can be passed to
 * computeRecordHash directly with no mapping glue.
 */
export type RecordHashFields = Pick<
  ProfileRow,
  | "name"
  | "blood_group"
  | "genotype"
  | "allergies"
  | "medications"
  | "chronic_conditions"
  | "emergency_contacts"
  | "language"
>;

/** Matches the 64-hex-char hex-encoded secret stored in profile_secrets. */
const HEX_SECRET_PATTERN = /^[0-9a-f]{64}$/i;

/**
 * Deterministic HMAC-SHA256 over the emergency-relevant facts of a card,
 * keyed by a per-patient secret (see lib/attestation/recordSecret.ts) —
 * the value attested on-chain (see README.md > Attestation & Trust Layer).
 *
 * This is a commitment scheme, not a plain hash: without `secretHex`
 * (256 bits, held only in the zero-grant `profile_secrets` table), an
 * adversary who has perfectly guessed every hashed field still cannot
 * compute a matching record_hash. This is what resists the low-entropy
 * dictionary/correlation attack described in
 * issues/issue-03-record-hash-commitment-scheme.md — plain SHA-256 over
 * low-entropy fields (bloodGroup: 9 values, genotype: 6, frequently-empty
 * arrays) would not.
 *
 * Array fields are sorted first so field order never changes the hash.
 */
export function computeRecordHash(
  fields: RecordHashFields,
  secretHex: string,
): string {
  if (!HEX_SECRET_PATTERN.test(secretHex)) {
    throw new Error(
      "computeRecordHash: secretHex must be a 64-character hex string",
    );
  }

  return computeRevisionCommitment(
    {
      name: fields.name,
      language: fields.language,
      blood_group: fields.blood_group,
      genotype: fields.genotype,
      allergies: fields.allergies,
      medications: fields.medications,
      chronic_conditions: fields.chronic_conditions,
      emergency_contacts: fields.emergency_contacts,
      date_of_birth: null,
      photo_url: null,
    } satisfies EmergencyRecordData,
    secretHex,
  );
}

/** Returns whether the current on-chain attestation exists and remains valid. */
export async function validateAttestation(
  recordHash: string,
): Promise<boolean> {
  const attestation = await getAttestation(recordHash);
  if (!attestation || attestation.revoked) return false;
  return (
    attestation.expiry === undefined || attestation.expiry > Date.now() / 1000
  );
}
