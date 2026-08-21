import type { EmergencyCardRow } from "@/lib/supabase/types";

type OfflineEnvelopeSourceProps = {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
};

/**
 * An inert, structured source document for the service worker. The worker
 * extracts this exact JSON into its own versioned Cache Storage envelope; it
 * never retains this page's rendered HTML. `</` is escaped to keep patient
 * supplied strings from terminating the script element.
 */
export function OfflineEnvelopeSource({
  card,
  authorizationKind,
}: OfflineEnvelopeSourceProps) {
  const source = JSON.stringify({
    version: 1,
    authorizationKind,
    offlineAllowed: card.offline_cache_allowed,
    authorizationExpiresAt: card.authorization_expires_at,
    recordUpdatedAt: card.record_updated_at,
    trust: { state: card.trust_state, updatedAt: card.trust_updated_at },
    projection: {
      name: card.name,
      age: card.age,
      bloodGroup: card.blood_group,
      genotype: card.genotype,
      allergies: card.allergies,
      medications: card.medications,
      chronicConditions: card.chronic_conditions,
      emergencyContacts: card.emergency_contacts,
      language: card.language,
    },
  }).replace(/</g, "\\u003c");

  return (
    <script
      id="lafiya-offline-envelope-source"
      type="application/json"
      // JSON is generated server-side from a constrained projection. Escaping
      // `<` above prevents a user string from breaking out of this inert tag.
      dangerouslySetInnerHTML={{ __html: source }}
    />
  );
}
