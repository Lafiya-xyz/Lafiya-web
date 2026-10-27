/**
 * @lafiya/protocol — record canonicalization and commitment scheme.
 *
 * This module is the portable, server-agnostic implementation of the Lafiya
 * record commitment algorithm. It has no server-only dependencies:
 * - Node.js `crypto` is used only when available (Web Crypto is the fallback).
 * - No secrets are accepted or stored here; the HMAC key is passed in by the
 *   caller and never persisted.
 *
 * The canonical form is stable: the same inputs always produce the same
 * JSON string and the same HMAC-SHA256 commitment regardless of field order.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  RECORD_SCHEMA_VERSION,
  type EmergencyRecordData,
} from "./types.js";

// ── Normalization helpers ─────────────────────────────────────────────────────

const normalizeText = (value: string): string =>
  value.normalize("NFC").trim().replace(/\s+/g, " ");

const normalizeList = (values: string[]): string[] =>
  [...new Set(values.map(normalizeText).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "en"),
  );

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const phone = parsePhoneNumberFromString(trimmed, "NG");
  return phone?.isValid() ? phone.number : trimmed.replace(/\s+/g, " ");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a copy of the record with all text fields NFC-normalized,
 * deduplicated, and sorted so that the canonical form is stable.
 */
export function normalizeEmergencyRecord(
  data: EmergencyRecordData,
): EmergencyRecordData {
  return {
    name: normalizeText(data.name),
    date_of_birth: data.date_of_birth || null,
    photo_url: data.photo_url?.trim() || null,
    language: data.language ? normalizeText(data.language) : null,
    blood_group: data.blood_group,
    genotype: data.genotype,
    allergies: normalizeList(data.allergies),
    medications: normalizeList(data.medications),
    chronic_conditions: normalizeList(data.chronic_conditions),
    emergency_contacts: data.emergency_contacts
      .map((contact) => ({
        name: normalizeText(contact.name),
        phone: normalizePhone(contact.phone),
        relationship: normalizeText(contact.relationship),
      }))
      .sort((a, b) =>
        `${a.name}\u0000${a.phone}\u0000${a.relationship}`.localeCompare(
          `${b.name}\u0000${b.phone}\u0000${b.relationship}`,
          "en",
        ),
      ),
  };
}

/**
 * Returns the stable JSON string over the emergency-relevant facts of a
 * patient record. Presentation-only fields (`date_of_birth`, `photo_url`,
 * and derived `age`) are excluded so that cosmetic changes do not affect
 * the commitment.
 *
 * This string is the input to `computeRevisionCommitment` and is also
 * published in test vectors so that the contracts repo and CHW tooling can
 * independently verify the canonical form.
 */
export function canonicalizeEmergencyRecord(data: EmergencyRecordData): string {
  const normalized = normalizeEmergencyRecord(data);
  return JSON.stringify({
    schemaVersion: RECORD_SCHEMA_VERSION,
    name: normalized.name,
    bloodGroup: normalized.blood_group,
    genotype: normalized.genotype,
    allergies: normalized.allergies,
    medications: normalized.medications,
    chronicConditions: normalized.chronic_conditions,
    emergencyContacts: normalized.emergency_contacts,
    language: normalized.language,
  });
}

// ── HMAC computation (cross-runtime) ─────────────────────────────────────────

const HEX_SECRET_PATTERN = /^[0-9a-f]{64}$/i;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute an HMAC-SHA256 commitment over the canonical record form.
 *
 * Uses the Node.js `crypto` module when available; falls back to the
 * Web Crypto API (available in all modern runtimes including browsers,
 * Deno, Bun, and edge workers) so that the package runs anywhere.
 *
 * @param canonical - Output of `canonicalizeEmergencyRecord`.
 * @param secretHex - 64-character lowercase hex string (256-bit key).
 * @returns 64-character lowercase hex HMAC-SHA256 digest.
 */
async function hmacSha256(
  canonical: string,
  secretHex: string,
): Promise<string> {
  // Try Node.js crypto first (synchronous, available in Node 18+)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = await import("node:crypto");
    return nodeCrypto
      .createHmac("sha256", Buffer.from(secretHex, "hex"))
      .update(canonical)
      .digest("hex");
  } catch {
    // Fall through to Web Crypto
  }

  // Web Crypto fallback (browser, Deno, edge runtimes)
  const keyBytes = hexToBytes(secretHex);
  const msgBytes = new TextEncoder().encode(canonical);
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, msgBytes);
  return bufferToHex(signature);
}

/**
 * Returns the HMAC-SHA256 commitment for the given record and secret.
 *
 * This is the value attested on-chain (see the Attestation struct). Without
 * the secret (256 bits, stored only in the zero-grant `profile_secrets`
 * table), an adversary who knows all medical fields cannot compute a matching
 * commitment — this resists low-entropy dictionary/correlation attacks on the
 * nine blood-group values and six genotype values.
 */
export async function computeRevisionCommitment(
  data: EmergencyRecordData,
  secretHex: string,
): Promise<string> {
  if (!HEX_SECRET_PATTERN.test(secretHex)) {
    throw new Error("INVALID_RECORD_SECRET");
  }
  return hmacSha256(canonicalizeEmergencyRecord(data), secretHex);
}

/**
 * Synchronous variant — only available in Node.js (uses `node:crypto`).
 * Import this only in Node.js server code; do not use in browser bundles.
 */
export function computeRevisionCommitmentSync(
  data: EmergencyRecordData,
  secretHex: string,
): string {
  if (!HEX_SECRET_PATTERN.test(secretHex)) {
    throw new Error("INVALID_RECORD_SECRET");
  }
  // This will throw at runtime in non-Node environments, which is intentional.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  return nodeCrypto
    .createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(canonicalizeEmergencyRecord(data))
    .digest("hex");
}
