/**
 * Patient-facing verification history timeline (issue #766).
 *
 * Merges attestation events and record revisions into plain-language state
 * transitions. Only fields permitted by the verifier-display policy are
 * surfaced; raw on-chain data (tx hashes, ledger numbers, keys) never is.
 */

export type VerifierDisplayPolicy = "hidden" | "organization" | "named";

export type AttestationEvent = {
  kind: "attested" | "revoked";
  at: string;
  recordVersion: number;
  verifierName?: string | null;
  verifierOrganization?: string | null;
  /** Indexed events may lag the ledger; false while not yet confirmed. */
  indexed?: boolean;
};

export type RecordRevision = { version: number; at: string };

export type TransitionType =
  "verified" | "revoked" | "stale_after_edit" | "pending_index";

export type TimelineEntry = {
  type: TransitionType;
  at: string;
  recordVersion: number;
  verifier: string | null;
  message: string;
  canRequestReverification: boolean;
};

export const TRANSITION_MESSAGES: Record<
  string,
  Record<TransitionType, (verifier: string | null) => string>
> = {
  en: {
    verified: (v) =>
      v ? `Your card was verified by ${v}.` : "Your card was verified.",
    revoked: (v) =>
      v
        ? `${v} withdrew their verification of your card.`
        : "A verification of your card was withdrawn.",
    stale_after_edit: () =>
      "Verification no longer matches your latest edit. Request re-verification to restore your verified badge.",
    pending_index: () =>
      "A verification change is being confirmed and may take a few minutes to appear.",
  },
};

export function displayVerifier(
  event: AttestationEvent,
  policy: VerifierDisplayPolicy,
): string | null {
  if (policy === "named")
    return event.verifierName ?? event.verifierOrganization ?? null;
  if (policy === "organization") return event.verifierOrganization ?? null;
  return null;
}

export function buildVerificationTimeline(
  events: AttestationEvent[],
  revisions: RecordRevision[],
  policy: VerifierDisplayPolicy,
  locale = "en",
): TimelineEntry[] {
  const messages = TRANSITION_MESSAGES[locale] ?? TRANSITION_MESSAGES.en;
  const entry = (
    type: TransitionType,
    at: string,
    recordVersion: number,
    verifier: string | null,
  ): TimelineEntry => ({
    type,
    at,
    recordVersion,
    verifier,
    message: messages[type](verifier),
    canRequestReverification: type === "stale_after_edit",
  });

  const entries: TimelineEntry[] = events.map((event) => {
    const verifier = displayVerifier(event, policy);
    if (event.indexed === false)
      return entry("pending_index", event.at, event.recordVersion, verifier);
    return entry(
      event.kind === "attested" ? "verified" : "revoked",
      event.at,
      event.recordVersion,
      verifier,
    );
  });

  const lastAttested = events
    .filter((e) => e.kind === "attested" && e.indexed !== false)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (lastAttested) {
    const staleRevision = revisions
      .filter((r) => r.version > lastAttested.recordVersion)
      .sort((a, b) => a.version - b.version)[0];
    if (staleRevision)
      entries.push(
        entry(
          "stale_after_edit",
          staleRevision.at,
          staleRevision.version,
          null,
        ),
      );
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
