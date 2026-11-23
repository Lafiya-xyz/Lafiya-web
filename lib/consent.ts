/**
 * Consent policy configuration.
 *
 * The single source of truth for the currently-active consent policy version.
 * Previously this was hard-coded inside `app/(auth)/signup/actions.ts`; it is
 * centralised here so the version lives in exactly one place and both signup
 * and the profile acknowledgement path stay in sync (see issue #146).
 */

import type { GuardianConsentRow } from "@/lib/supabase/types";

export const CURRENT_POLICY_VERSION = "ndpa-2023-v1";

/** Human-readable label for the active policy, used in the UI. */
export const CURRENT_POLICY_LABEL = "NDPA (2023)";

/** Routes the active policy content is linked from. */
export const POLICY_ROUTES = {
  terms: "/terms",
  privacy: "/privacy",
} as const;

// ---------------------------------------------------------------------------
// Issue #871: verifiable guardian consent for minors' cards (NDPA s.31).
// Mirrors public.set_dependant_card_public() in
// supabase/migrations/20261123120000_guardian_consent_assurance.sql, which is
// the enforcing check; this module drives the UI and server actions.
// ---------------------------------------------------------------------------

export const GUARDIAN_ASSURANCE_METHODS = [
  "chw_in_person",
  "facility_confirmation",
  "document_review",
] as const;

export type GuardianAssuranceMethod =
  (typeof GUARDIAN_ASSURANCE_METHODS)[number];

export const GUARDIAN_ASSURANCE_LABELS: Record<
  GuardianAssuranceMethod,
  string
> = {
  chw_in_person: "In-person confirmation by a community health worker",
  facility_confirmation: "Confirmation by a health facility",
  document_review: "Document reviewed by a Lafiya operator",
};

/** Consent ledger row. Evidence is an opaque reference, never a document. */
export type GuardianConsentRecord = GuardianConsentRow;

export type MinorActivationDecision =
  | { allowed: true; basis: "verified_consent" | "emergency" }
  | {
      allowed: false;
      reason:
        | "consent_required"
        | "consent_pending"
        | "guardian_changed"
        | "majority_reconfirm";
    };

/**
 * Decides whether a dependant's card may be made public. Minors (or a
 * missing date of birth: fail closed) need verified consent from the current
 * guardian under the current policy version. Emergency activation is only
 * honoured when the deployment enables it. Once the dependant reaches the
 * age of majority (lib/account/guardianHandover.ts) guardian consent no
 * longer applies: the dependant must re-confirm from their own account.
 */
export function decideMinorCardActivation(input: {
  isMinor: boolean;
  currentGuardianId: string;
  consents: readonly GuardianConsentRecord[];
  emergency?: boolean;
  allowEmergencyActivation?: boolean;
  policyVersion?: string;
}): MinorActivationDecision {
  const policyVersion = input.policyVersion ?? CURRENT_POLICY_VERSION;
  if (!input.isMinor) return { allowed: false, reason: "majority_reconfirm" };
  if (input.emergency && input.allowEmergencyActivation) {
    return { allowed: true, basis: "emergency" };
  }
  const current = input.consents.filter(
    (c) => c.policy_version === policyVersion && c.status !== "rejected",
  );
  const fromGuardian = current.filter(
    (c) => c.guardian_id === input.currentGuardianId,
  );
  if (fromGuardian.some((c) => c.status === "verified")) {
    return { allowed: true, basis: "verified_consent" };
  }
  if (fromGuardian.some((c) => c.status === "pending")) {
    return { allowed: false, reason: "consent_pending" };
  }
  if (current.some((c) => c.status === "verified")) {
    return { allowed: false, reason: "guardian_changed" };
  }
  return { allowed: false, reason: "consent_required" };
}
