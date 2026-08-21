import type { TrustState } from "./types";

export type TrustEvidence = {
  requestCurrent: boolean;
  intentSubmitted: boolean;
  observed: boolean;
  finalized: boolean;
  revoked: boolean;
  expiresAt: string | null;
  providerConflict: boolean;
  providerAvailable: boolean;
};

/**
 * A deliberately conservative projection. Provider observation cannot return
 * `verified`; only finalized, current, non-revoked evidence can do that.
 */
export function resolveTrustState(
  evidence: TrustEvidence,
  now = new Date(),
): TrustState {
  if (!evidence.requestCurrent) return "superseded";
  if (evidence.providerConflict) return "conflicted";
  if (!evidence.providerAvailable) return "unavailable";
  if (evidence.revoked) return "revoked";
  if (
    evidence.expiresAt !== null &&
    Number.isFinite(Date.parse(evidence.expiresAt)) &&
    Date.parse(evidence.expiresAt) <= now.getTime()
  ) {
    return "expired";
  }
  if (evidence.finalized) return "verified";
  if (evidence.observed) return "confirming";
  if (evidence.intentSubmitted) return "submitted";
  return "unverified";
}
