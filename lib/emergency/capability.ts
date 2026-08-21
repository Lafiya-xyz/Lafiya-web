import "server-only";

import { createHash, randomBytes } from "node:crypto";

export const CAPABILITY_PREFIX = "lafiya_e1_";
export const CAPABILITY_TOKEN_PATTERN = /^lafiya_e1_[A-Za-z0-9_-]{43}$/;

/**
 * Capability values are 256 random bits encoded with base64url. The prefix
 * versions the public protocol without adding entropy-bearing metadata.
 */
export function createRawCapability(): string {
  return `${CAPABILITY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isCapabilityToken(value: string): boolean {
  return CAPABILITY_TOKEN_PATTERN.test(value);
}

/** Only this one-way digest is persisted or sent to Postgres. */
export function digestCapability(rawCapability: string): string {
  if (!isCapabilityToken(rawCapability)) {
    throw new Error("INVALID_CAPABILITY");
  }
  return createHash("sha256").update(rawCapability).digest("hex");
}

export const EMERGENCY_FIELD_ALLOWLIST = Object.freeze({
  name: true,
  age: true,
  photo_url: true,
  blood_group: true,
  genotype: true,
  allergies: true,
  medications: true,
  chronic_conditions: true,
  emergency_contacts: true,
  language: true,
});
