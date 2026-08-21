import { createHmac } from "node:crypto";

import { parsePhoneNumberFromString } from "libphonenumber-js";

import type {
  BloodGroup,
  EmergencyContact,
  Genotype,
  ProfileRow,
} from "@/lib/supabase/types";

export const RECORD_SCHEMA_VERSION = 1 as const;

export type EmergencyRecordData = {
  name: string;
  date_of_birth: string | null;
  photo_url: string | null;
  language: string | null;
  blood_group: BloodGroup;
  genotype: Genotype;
  allergies: string[];
  medications: string[];
  chronic_conditions: string[];
  emergency_contacts: EmergencyContact[];
};

export type DisclosureField = keyof EmergencyRecordData | "age";
export type DisclosurePolicy = {
  version: 1;
  fields: Record<DisclosureField, boolean>;
};

export const DEFAULT_DISCLOSURE_POLICY: DisclosurePolicy = {
  version: 1,
  fields: {
    name: true,
    date_of_birth: false,
    age: true,
    photo_url: true,
    language: true,
    blood_group: true,
    genotype: true,
    allergies: true,
    medications: true,
    chronic_conditions: true,
    emergency_contacts: true,
  },
};

const normalizeText = (value: string) =>
  value.normalize("NFC").trim().replace(/\s+/g, " ");

const normalizeList = (values: string[]) =>
  [...new Set(values.map(normalizeText).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const phone = parsePhoneNumberFromString(trimmed, "NG");
  return phone?.isValid() ? phone.number : trimmed.replace(/\s+/g, " ");
}

export function normalizeEmergencyRecord(
  data: EmergencyRecordData,
): EmergencyRecordData {
  return {
    name: normalizeText(data.name),
    date_of_birth: data.date_of_birth || null,
    photo_url: data.photo_url?.trim() || null,
    language: data.language ? normalizeText(data.language) : null,
    blood_group: data.blood_group,
    genotype: data.genotype,
    allergies: normalizeList(data.allergies),
    medications: normalizeList(data.medications),
    chronic_conditions: normalizeList(data.chronic_conditions),
    emergency_contacts: data.emergency_contacts
      .map((contact) => ({
        name: normalizeText(contact.name),
        phone: normalizePhone(contact.phone),
        relationship: normalizeText(contact.relationship),
      }))
      .sort((a, b) =>
        `${a.name}\u0000${a.phone}\u0000${a.relationship}`.localeCompare(
          `${b.name}\u0000${b.phone}\u0000${b.relationship}`,
          "en",
        ),
      ),
  };
}

/**
 * Stable cross-repository commitment input. Presentation-only date/photo and
 * disclosure choices are deliberately excluded. Null is distinct from an
 * empty list and enum `unknown` is distinct from absent data.
 */
export function canonicalizeEmergencyRecord(data: EmergencyRecordData): string {
  const normalized = normalizeEmergencyRecord(data);
  return JSON.stringify({
    schemaVersion: RECORD_SCHEMA_VERSION,
    name: normalized.name,
    bloodGroup: normalized.blood_group,
    genotype: normalized.genotype,
    allergies: normalized.allergies,
    medications: normalized.medications,
    chronicConditions: normalized.chronic_conditions,
    emergencyContacts: normalized.emergency_contacts,
    language: normalized.language,
  });
}

export function computeRevisionCommitment(
  data: EmergencyRecordData,
  secretHex: string,
): string {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new Error("INVALID_RECORD_SECRET");
  }
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(canonicalizeEmergencyRecord(data))
    .digest("hex");
}

export function profileToEmergencyRecord(
  profile: Pick<
    ProfileRow,
    | "name"
    | "date_of_birth"
    | "photo_url"
    | "language"
    | "blood_group"
    | "genotype"
    | "allergies"
    | "medications"
    | "chronic_conditions"
    | "emergency_contacts"
  >,
): EmergencyRecordData {
  return normalizeEmergencyRecord(profile);
}
