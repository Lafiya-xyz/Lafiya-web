import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ProtocolError,
  type AttestationIntentPayload,
  type SignedAttestationIntent,
} from "./types";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function signatureFor(
  payload: AttestationIntentPayload,
  signingKey: string,
): string {
  return createHmac("sha256", signingKey)
    .update(canonicalJson(payload))
    .digest("base64url");
}

/**
 * Signs the authorization artifact issued after the database atomically
 * claims the request. The signer is an application control, not a substitute
 * for the CHW's Stellar authorization; the receiving verifier must check both.
 */
export function signAttestationIntent(
  payload: AttestationIntentPayload,
  signingKey: string,
): SignedAttestationIntent {
  if (!signingKey) throw new ProtocolError("INVALID_INTENT");
  return { payload, signature: signatureFor(payload, signingKey) };
}

/** Verifies integrity and expiry before a verifier accepts an intent. */
export function verifyAttestationIntent(
  intent: SignedAttestationIntent,
  signingKey: string,
  now = new Date(),
): AttestationIntentPayload {
  if (!intent?.payload || typeof intent.signature !== "string") {
    throw new ProtocolError("INVALID_INTENT");
  }
  const expected = Buffer.from(signatureFor(intent.payload, signingKey));
  const actual = Buffer.from(intent.signature);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    intent.payload.version !== 1
  ) {
    throw new ProtocolError("INVALID_INTENT");
  }
  const expiry = Date.parse(intent.payload.expiresAt);
  if (!Number.isFinite(expiry)) throw new ProtocolError("INVALID_INTENT");
  if (expiry <= now.getTime()) throw new ProtocolError("INTENT_EXPIRED");
  return intent.payload;
}
