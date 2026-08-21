import { createHash } from "node:crypto";

export const TRUST_DECISION_STATUSES = [
  "unverified",
  "submitted",
  "confirming",
  "verified",
  "expired",
  "revoked",
  "superseded",
  "conflicted",
  "unavailable",
] as const;

export type TrustDecisionStatus = (typeof TRUST_DECISION_STATUSES)[number];

export type AttestationIntent = {
  requestId: string;
  revisionId: string;
  recordHash: string;
  schemaVersion: number;
  networkPassphraseHash: string;
  contractId: string;
  chwId: string;
  stellarAddress: string;
  expiresAt: string;
};

export type AttestationIntentError =
  | "INVALID_INTENT"
  | "INTENT_EXPIRED"
  | "INVALID_RECORD_HASH"
  | "INVALID_NETWORK_HASH";

const HASH = /^[a-f0-9]{64}$/;

/**
 * Stable JSON serialization for a CHW signature. This intentionally contains
 * identifiers and commitments only: never a patient name or medical field.
 */
export function canonicalizeAttestationIntent(
  intent: AttestationIntent,
): string {
  return JSON.stringify({
    chwId: intent.chwId,
    contractId: intent.contractId,
    expiresAt: intent.expiresAt,
    networkPassphraseHash: intent.networkPassphraseHash,
    recordHash: intent.recordHash,
    requestId: intent.requestId,
    revisionId: intent.revisionId,
    schemaVersion: intent.schemaVersion,
    stellarAddress: intent.stellarAddress,
  });
}

export function hashNetworkPassphrase(networkPassphrase: string): string {
  return createHash("sha256").update(networkPassphrase, "utf8").digest("hex");
}

export function hashAttestationIntent(intent: AttestationIntent): string {
  return createHash("sha256")
    .update(canonicalizeAttestationIntent(intent), "utf8")
    .digest("hex");
}

/** Validate only structural/freshness properties; signature verification is wallet-specific. */
export function validateAttestationIntent(
  intent: AttestationIntent,
  now = new Date(),
): AttestationIntentError | null {
  if (
    !intent.requestId ||
    !intent.revisionId ||
    !intent.contractId ||
    !intent.chwId ||
    !intent.stellarAddress ||
    !Number.isInteger(intent.schemaVersion) ||
    intent.schemaVersion < 1
  ) {
    return "INVALID_INTENT";
  }
  if (!HASH.test(intent.recordHash)) return "INVALID_RECORD_HASH";
  if (!HASH.test(intent.networkPassphraseHash)) return "INVALID_NETWORK_HASH";
  const expiry = new Date(intent.expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry <= now) return "INTENT_EXPIRED";
  return null;
}

export function trustStatusCopy(status: TrustDecisionStatus): {
  label: string;
  detail: string;
} {
  const copy: Record<TrustDecisionStatus, { label: string; detail: string }> = {
    unverified: {
      label: "Not verified",
      detail: "No final verification evidence is available.",
    },
    submitted: {
      label: "Verification submitted",
      detail: "The verification is awaiting ledger confirmation.",
    },
    confirming: {
      label: "Verification confirming",
      detail: "Ledger evidence was observed but is not final yet.",
    },
    verified: {
      label: "Verified",
      detail: "The exact record revision has final verification evidence.",
    },
    expired: {
      label: "Verification expired",
      detail: "The recorded verification is no longer valid.",
    },
    revoked: {
      label: "Verification revoked",
      detail: "The recorded verification was revoked.",
    },
    superseded: {
      label: "Verification superseded",
      detail: "A newer record revision requires its own verification.",
    },
    conflicted: {
      label: "Verification unavailable",
      detail: "Verification sources disagree; do not rely on this status.",
    },
    unavailable: {
      label: "Verification unavailable",
      detail: "Verification evidence cannot be checked right now.",
    },
  };
  return copy[status];
}
