import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";

/**
 * Application-layer envelope encryption for clinical profile fields.
 *
 * Design (see ADR for #570):
 * - Algorithm: AES-256-GCM.
 * - Envelope: a per-user data key (DEK) is generated once and wrapped by a
 *   KMS-held master key (KEK). Only the wrapped DEK is persisted; the KEK never
 *   leaves the KMS boundary.
 * - AAD binds ciphertext to the owning `user_id` and the logical field name so a
 *   ciphertext cannot be replayed against another user or field.
 * - Every ciphertext carries a key-ID header so keys can be rotated without
 *   downtime: new writes use the active key ID, reads dispatch on the embedded
 *   key ID.
 *
 * This module is intentionally free of any logging: PHI and key material must
 * never be written to logs, persisted in plaintext, or sent to third parties.
 */

/** Logical clinical fields that are encrypted at rest. */
export const CLINICAL_FIELDS = [
  "allergies",
  "medications",
  "conditions",
  "genotype",
] as const;

export type ClinicalField = (typeof CLINICAL_FIELDS)[number];

/** Versioned envelope header prefix, e.g. `v1:<keyId>:<iv>:<tag>:<ct>`. */
export const ENVELOPE_VERSION = "v1";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, recommended for GCM
const TAG_BYTES = 16;

/**
 * A KMS-backed key provider. Implementations wrap/unwrap data keys with the
 * master key held by Supabase Vault, AWS KMS, or GCP KMS. The provider is
 * injected so the crypto layer stays testable and KMS-agnostic.
 */
export interface KeyProvider {
  /** Key ID currently used for new writes. */
  activeKeyId(): string;
  /** Wrap (encrypt) a raw data key with the master key identified by keyId. */
  wrapDataKey(keyId: string, dataKey: Buffer): Promise<Buffer>;
  /** Unwrap (decrypt) a wrapped data key using the master key identified by keyId. */
  unwrapDataKey(keyId: string, wrappedDataKey: Buffer): Promise<Buffer>;
}

/** A wrapped per-user data key as persisted alongside the user record. */
export interface WrappedDataKey {
  keyId: string;
  wrapped: Buffer;
}

/**
 * Generate a fresh per-user data key and wrap it with the active master key.
 * Call once per user; the returned wrapped key is safe to persist.
 */
export async function generateWrappedDataKey(
  provider: KeyProvider,
): Promise<WrappedDataKey> {
  const keyId = provider.activeKeyId();
  const dataKey = randomBytes(KEY_BYTES);
  const wrapped = await provider.wrapDataKey(keyId, dataKey);
  // Best-effort scrub of the raw key from this scope.
  dataKey.fill(0);
  return { keyId, wrapped };
}

/**
 * Build the AAD that binds a ciphertext to its owner and logical field.
 * Binding both prevents cross-user and cross-field ciphertext substitution.
 */
export function buildAad(userId: string, field: ClinicalField): Buffer {
  if (!userId) {
    throw new Error("buildAad: userId is required");
  }
  return Buffer.from(`${ENVELOPE_VERSION}:${userId}:${field}`, "utf8");
}

/**
 * Encrypt a single clinical field value for a user.
 *
 * Returns a self-describing envelope string carrying the key ID so rotation is
 * transparent to readers. `null`/`undefined`/empty values are returned as-is so
 * absence of data is not conflated with an encrypted empty string.
 */
export async function encryptField(
  provider: KeyProvider,
  wrappedDataKey: WrappedDataKey,
  userId: string,
  field: ClinicalField,
  plaintext: string | null | undefined,
): Promise<string | null> {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }

  const dataKey = await provider.unwrapDataKey(
    wrappedDataKey.keyId,
    wrappedDataKey.wrapped,
  );
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, dataKey, iv);
    cipher.setAAD(buildAad(userId, field));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      wrappedDataKey.keyId,
      iv.toString("base64"),
      tag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(":");
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Decrypt a single clinical field value for a user.
 *
 * Dispatches on the key ID embedded in the envelope, so ciphertexts written
 * under a previous key remain readable after rotation. Returns `null` for
 * absent values and throws on tampering or AAD mismatch.
 */
export async function decryptField(
  provider: KeyProvider,
  wrappedDataKey: WrappedDataKey,
  userId: string,
  field: ClinicalField,
  envelope: string | null | undefined,
): Promise<string | null> {
  if (envelope === null || envelope === undefined || envelope === "") {
    return null;
  }

  const parts = envelope.split(":");
  if (parts.length !== 5) {
    throw new Error("decryptField: malformed envelope");
  }
  const [version, keyId, ivB64, tagB64, ctB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`decryptField: unsupported envelope version ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("decryptField: invalid IV or auth tag length");
  }

  // The wrapped key may have been rotated; unwrap using the envelope's key ID.
  const dataKey = await provider.unwrapDataKey(keyId, wrappedDataKey.wrapped);
  try {
    const decipher = createDecipheriv(ALGORITHM, dataKey, iv);
    decipher.setAAD(buildAad(userId, field));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Encrypt every clinical field on a profile row. Non-clinical fields are left
 * untouched so the migration surface stays limited to PHI.
 */
export async function encryptClinicalFields(
  provider: KeyProvider,
  wrappedDataKey: WrappedDataKey,
  userId: string,
  profile: Partial<Record<ClinicalField, string | null | undefined>>,
): Promise<Partial<Record<ClinicalField, string | null>>> {
  const out: Partial<Record<ClinicalField, string | null>> = {};
  for (const field of CLINICAL_FIELDS) {
    if (field in profile) {
      out[field] = await encryptField(
        provider,
        wrappedDataKey,
        userId,
        field,
        profile[field],
      );
    }
  }
  return out;
}

/**
 * Decrypt every clinical field on a profile row. Used by the card RPC path
 * after capability resolution, in the app tier.
 */
export async function decryptClinicalFields(
  provider: KeyProvider,
  wrappedDataKey: WrappedDataKey,
  userId: string,
  profile: Partial<Record<ClinicalField, string | null | undefined>>,
): Promise<Partial<Record<ClinicalField, string | null>>> {
  const out: Partial<Record<ClinicalField, string | null>> = {};
  for (const field of CLINICAL_FIELDS) {
    if (field in profile) {
      out[field] = await decryptField(
        provider,
        wrappedDataKey,
        userId,
        field,
        profile[field],
      );
    }
  }
  return out;
}

/**
 * Constant-time comparison helper for key IDs / fingerprints where equality
 * checks touch secret-derived material.
 */
export function keyIdsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}
