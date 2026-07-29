import { createHash } from "node:crypto";

import type { EmergencyCardRow } from "@/lib/supabase/types";
import { getAttestation } from "@/lib/stellar/attestation";

/**
 * Validate that an attestation for the given record hash is present, not expired, and not revoked.
 */
export async function validateAttestation(recordHash: string): Promise<boolean> {
  const att = await getAttestation(recordHash);
  if (!att) return false;
  const now = Math.floor(Date.now() / 1000);
  if (att.revoked) return false;
  if (att.expiry && att.expiry < now) return false;
  return true;
}

/**
 * Deterministic SHA-256 over the emergency-relevant facts of a card — the
 * value that would be looked up on-chain once lafiya-contracts exists (see
 * README.md > Attestation & Trust Layer). Excludes photo_url: attestation
 * covers the emergency medical facts, not the cosmetic/identity photo.
 * Array fields are sorted first so field order never changes the hash.
 */
export function computeRecordHash(card: EmergencyCardRow): string {
  const canonical = JSON.stringify({
    name: card.name,
    age: card.age,
    bloodGroup: card.blood_group,
    genotype: card.genotype,
    allergies: [...card.allergies].sort(),
    medications: [...card.medications].sort(),
    chronicConditions: [...card.chronic_conditions].sort(),
    emergencyContacts: [...card.emergency_contacts]
      .map((contact) => ({
        name: contact.name,
        phone: contact.phone,
        relationship: contact.relationship,
      }))
      .sort((a, b) =>
        `${a.name}${a.phone}`.localeCompare(`${b.name}${b.phone}`),
      ),
    language: card.language,
  });

  return createHash("sha256").update(canonical).digest("hex");
}
