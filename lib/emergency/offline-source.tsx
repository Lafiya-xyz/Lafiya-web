import type { EmergencyCardRow } from "@/lib/supabase/types";

type OfflineEnvelopeSourceProps = {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
};

export type EmergencyCardSourceResult<T> = {
  source: "live" | "cache";
  data: T;
};

/**
 * Decides whether to serve a live network fetch of the emergency card or the
 * cached/offline copy already in Cache Storage. Used by the service worker
 * fetch handler so a "last updated" timestamp from the offline envelope is
 * never presented as if it were fresh when a fast network was actually
 * available.
 *
 * Online + fast: the live fetch wins the race and its data is used.
 * Offline: the live fetch never resolves (or rejects) so the cache read
 * wins.
 * Slow connection: the live fetch is raced against `timeoutMs`; if it does
 * not resolve in time, the cache read is used instead so the caller never
 * hangs waiting on a stalled network.
 */
export async function resolveEmergencyCardSource<T>(
  fetchLive: () => Promise<T>,
  readCache: () => Promise<T>,
  timeoutMs = 3000,
): Promise<EmergencyCardSourceResult<T>> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("EMERGENCY_CARD_SOURCE_TIMEOUT")),
      timeoutMs,
    );
  });

  try {
    const data = await Promise.race([fetchLive(), timeout]);
    return { source: "live", data };
  } catch {
    const data = await readCache();
    return { source: "cache", data };
  }
}

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
