/**
 * @lafiya/protocol — record hash helpers.
 *
 * The subset of emergency card fields that feed the on-chain commitment.
 * `age` and `photo_url` are intentionally excluded (presentation-only).
 */

import {
  canonicalizeEmergencyRecord,
  computeRevisionCommitment,
  computeRevisionCommitmentSync,
} from "./canonicalization.js";
import type { BloodGroup, EmergencyContact, Genotype } from "./types.js";

/** The subset of card fields that feed the HMAC commitment. */
export type RecordHashFields = {
  name: string;
  blood_group: BloodGroup;
  genotype: Genotype;
  allergies: string[];
  medications: string[];
  chronic_conditions: string[];
  emergency_contacts: EmergencyContact[];
  language: string | null;
};

const HEX_SECRET_PATTERN = /^[0-9a-f]{64}$/i;

function fieldsToRecordData(fields: RecordHashFields) {
  return {
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
  } as const;
}

/**
 * Async HMAC-SHA256 commitment over the emergency-relevant facts of a card.
 * Works in all runtimes (Node.js, browser, Deno, edge workers).
 */
export async function computeRecordHash(
  fields: RecordHashFields,
  secretHex: string,
): Promise<string> {
  if (!HEX_SECRET_PATTERN.test(secretHex)) {
    throw new Error(
      "computeRecordHash: secretHex must be a 64-character hex string",
    );
  }
  return computeRevisionCommitment(fieldsToRecordData(fields), secretHex);
}

/**
 * Synchronous variant — Node.js only. Import only in server-side code.
 */
export function computeRecordHashSync(
  fields: RecordHashFields,
  secretHex: string,
): string {
  if (!HEX_SECRET_PATTERN.test(secretHex)) {
    throw new Error(
      "computeRecordHashSync: secretHex must be a 64-character hex string",
    );
  }
  return computeRevisionCommitmentSync(fieldsToRecordData(fields), secretHex);
}

export { canonicalizeEmergencyRecord } from "./canonicalization.js";
