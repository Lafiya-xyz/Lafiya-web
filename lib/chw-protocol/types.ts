/**
 * Protocol-only values. These objects intentionally contain no emergency
 * record fields. A commitment may be used inside an authorized, short-lived
 * attestation intent but must never be put in logs, telemetry, or URLs.
 */
export const PROTOCOL_ERROR_CODES = [
  "AUTH_REQUIRED",
  "CHW_NOT_AUTHORIZED",
  "CHW_SUSPENDED",
  "CHW_CREDENTIAL_EXPIRED",
  "REQUEST_NOT_FOUND",
  "REQUEST_NOT_CURRENT",
  "REQUEST_ALREADY_CLAIMED",
  "LEASE_EXPIRED",
  "LEASE_NOT_OWNER",
  "INTENT_EXPIRED",
  "INTENT_REPLAYED",
  "INTENT_SUPERSEDED",
  "WRONG_ADDRESS",
  "WRONG_NETWORK",
  "WRONG_CONTRACT",
  "UNSUPPORTED_EPOCH",
  "UNSUPPORTED_SCHEMA",
  "INVALID_INTENT",
  "PRODUCTION_MOCK_FORBIDDEN",
  "PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE",
  "INTENT_SIGNING_KEY_REQUIRED",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type TrustState =
  | "unverified"
  | "submitted"
  | "confirming"
  | "verified"
  | "expired"
  | "revoked"
  | "superseded"
  | "conflicted"
  | "unavailable";

export type ProtocolEpoch = {
  id: string;
  schemaVersion: number;
  networkPassphraseHash: string;
  contractId: string;
  contractVersion: string;
  eventVersion: number;
  finalityDepth: number;
  status: "active" | "deprecated" | "retired";
};

export type AttestationIntentPayload = {
  version: 1;
  intentId: string;
  requestId: string;
  revisionId: string;
  /** HMAC-backed commitment; permitted only in this authorized intent. */
  recordCommitment: string;
  schemaVersion: number;
  chwId: string;
  stellarAddress: string;
  epoch: Pick<
    ProtocolEpoch,
    | "id"
    | "networkPassphraseHash"
    | "contractId"
    | "contractVersion"
    | "eventVersion"
  >;
  idempotencyKey: string;
  issuedAt: string;
  expiresAt: string;
};

export type SignedAttestationIntent = {
  payload: AttestationIntentPayload;
  signature: string;
};
