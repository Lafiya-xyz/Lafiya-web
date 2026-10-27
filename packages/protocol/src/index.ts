/**
 * @lafiya/protocol
 *
 * Canonicalization, hashing, intent types, and attestation schemas for the
 * Lafiya emergency health record protocol.
 *
 * This package contains NO server-only or secret-handling code. It is safe to
 * import from browsers, edge workers, Deno, Bun, and Node.js environments.
 *
 * Semver rules:
 *   PATCH — documentation or description changes only
 *   MINOR — new optional fields; existing commitments remain valid
 *   MAJOR — canonical form changes; RECORD_SCHEMA_VERSION is incremented
 */

// Types
export type {
  BloodGroup,
  Genotype,
  EmergencyContact,
  EmergencyRecordData,
  DisclosureField,
  DisclosurePolicy,
  Attestation,
  ProtocolErrorCode,
  ProtocolEpoch,
  AttestationIntentPayload,
  SignedAttestationIntent,
  RecordSchemaVersion,
} from "./types.js";

export {
  RECORD_SCHEMA_VERSION,
  PROTOCOL_ERROR_CODES,
  ProtocolError,
} from "./types.js";

// Canonicalization
export {
  normalizeEmergencyRecord,
  canonicalizeEmergencyRecord,
  computeRevisionCommitment,
  computeRevisionCommitmentSync,
} from "./canonicalization.js";

// Record hash
export type { RecordHashFields } from "./recordHash.js";
export {
  computeRecordHash,
  computeRecordHashSync,
} from "./recordHash.js";
