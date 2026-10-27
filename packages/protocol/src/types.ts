/**
 * @lafiya/protocol — core type definitions.
 *
 * These types are the shared contract between the Lafiya web app, the CHW
 * verifier tooling, and the contracts repo. They contain NO server-only or
 * secret-handling code — only pure data shapes and enumerated values.
 */

// ── Schema versioning ────────────────────────────────────────────────────────

/** Current schema version. Increment when the canonical form changes. */
export const RECORD_SCHEMA_VERSION = 1 as const;
export type RecordSchemaVersion = typeof RECORD_SCHEMA_VERSION;

// ── Clinical field enumerations ──────────────────────────────────────────────

export type BloodGroup =
  | "A+"
  | "A-"
  | "B+"
  | "B-"
  | "AB+"
  | "AB-"
  | "O+"
  | "O-"
  | "unknown";

export type Genotype = "AA" | "AS" | "SS" | "SC" | "AC" | "unknown";

// ── Record shapes ─────────────────────────────────────────────────────────────

export type EmergencyContact = {
  name: string;
  phone: string;
  relationship: string;
};

/**
 * The full set of emergency-relevant fields that can appear on a patient
 * record. Presentation-only fields (age, photo_url) are deliberately absent
 * from the canonical form and the commitment scheme.
 */
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

// ── Disclosure policy ─────────────────────────────────────────────────────────

export type DisclosureField = keyof EmergencyRecordData | "age";
export type DisclosurePolicy = {
  version: 1;
  fields: Record<DisclosureField, boolean>;
};

// ── Attestation ───────────────────────────────────────────────────────────────

/**
 * Mirrors the planned Soroban Attestation struct. Never carries patient data —
 * only a hash, an attester identity, and a timestamp.
 */
export type Attestation = {
  recordHash: string;
  /** Stellar address of the allowlisted health worker who attested. */
  attester: string;
  /** Unix seconds. */
  timestamp: number;
  /** Optional expiry timestamp (Unix seconds). */
  expiry?: number;
  /** Optional revocation flag. */
  revoked?: boolean;
};

// ── Protocol errors ───────────────────────────────────────────────────────────

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
  "INVALID_TRANSITION",
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

// ── Protocol epochs ───────────────────────────────────────────────────────────

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

// ── Intent types ──────────────────────────────────────────────────────────────

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

// ── Semver rules ──────────────────────────────────────────────────────────────
//
// Schema versioning is tied to the RECORD_SCHEMA_VERSION constant:
//
//   PATCH bump  — documentation, comment, or test-vector description changes
//                 that do not affect canonical output or commitment values.
//   MINOR bump  — new optional fields added to EmergencyRecordData; existing
//                 commitments remain valid.
//   MAJOR bump  — canonical form changes (field rename, normalization rule
//                 change, new required field). All existing commitments are
//                 invalidated; RECORD_SCHEMA_VERSION must be incremented.
//
// The CI release workflow verifies test vectors before publishing to ensure
// no accidental commitment-breaking change is shipped.
