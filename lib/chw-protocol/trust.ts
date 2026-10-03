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
  /**
   * Whether the attester was allowlisted at the attestation's ledger, as
   * resolved from indexed allowlist history. `null` means the historical
   * allowlist state is unknown and must not be treated as allowlisted.
   */
  attesterAllowlistedAtLedger: boolean | null;
  /**
   * Whether the attester's key was suspended for compromise at or before the
   * attestation ledger. Compromised-key suspensions invalidate retroactively
   * after the suspension ledger (see ADR on allowlist history).
   */
  attesterCompromisedAtLedger: boolean;
};

export type TrustReasonCode =
  | "request_superseded"
  | "provider_conflict"
  | "provider_unavailable"
  | "attestation_revoked"
  | "attestation_expired"
  | "attester_not_allowlisted_at_ledger"
  | "attester_allowlist_unknown"
  | "attester_compromised_at_ledger"
  | "attestation_finalized"
  | "attestation_observed"
  | "attestation_submitted"
  | "attestation_unverified";

export type TrustDecision = {
  state: TrustState;
  reason: TrustReasonCode;
};

/**
 * A deliberately conservative projection. Provider observation cannot return
 * `verified`; only finalized, current, non-revoked evidence can do that.
 *
 * Allowlist trust is evaluated against the attester allowlist as it stood at
 * the attestation ledger, so later removals do not retroactively invalidate
 * honest attestations and later additions cannot legitimize old ones.
 */
export function resolveTrustState(
  evidence: TrustEvidence,
  now = new Date(),
): TrustState {
  return resolveTrustDecision(evidence, now).state;
}

export function resolveTrustDecision(
  evidence: TrustEvidence,
  now = new Date(),
): TrustDecision {
  if (!evidence.requestCurrent) {
    return { state: "superseded", reason: "request_superseded" };
  }
  if (evidence.providerConflict) {
    return { state: "conflicted", reason: "provider_conflict" };
  }
  if (!evidence.providerAvailable) {
    return { state: "unavailable", reason: "provider_unavailable" };
  }
  if (evidence.revoked) {
    return { state: "revoked", reason: "attestation_revoked" };
  }
  if (
    evidence.expiresAt !== null &&
    Number.isFinite(Date.parse(evidence.expiresAt)) &&
    Date.parse(evidence.expiresAt) <= now.getTime()
  ) {
    return { state: "expired", reason: "attestation_expired" };
  }
  if (evidence.attesterCompromisedAtLedger) {
    return { state: "revoked", reason: "attester_compromised_at_ledger" };
  }
  if (evidence.attesterAllowlistedAtLedger === null) {
    return { state: "unverified", reason: "attester_allowlist_unknown" };
  }
  if (!evidence.attesterAllowlistedAtLedger) {
    return {
      state: "unverified",
      reason: "attester_not_allowlisted_at_ledger",
    };
  }
  if (evidence.finalized) {
    return { state: "verified", reason: "attestation_finalized" };
  }
  if (evidence.observed) {
    return { state: "confirming", reason: "attestation_observed" };
  }
  if (evidence.intentSubmitted) {
    return { state: "submitted", reason: "attestation_submitted" };
  }
  return { state: "unverified", reason: "attestation_unverified" };
}
