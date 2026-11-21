import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getRuntimeConfig } from "@/lib/runtime-config";

/**
 * Verify-only NIN handling (issue #940).
 *
 * Design invariant: the raw NIN never leaves this module's callers in a
 * persisted form. Callers pass the NIN in, get back a keyed hash plus the
 * provider verdict, and store only those. See
 * `docs/nin-verification-spike.md` for the legal basis and threat model.
 */

/** NIN is exactly 11 digits (NIMC national identification number). */
export const NIN_PATTERN = /^\d{11}$/;

export type NinVerificationStatus = "verified" | "not_verified" | "unavailable";

export type NinVerificationResult = {
  /** HMAC-SHA256(pepper, normalized NIN), hex. Safe to persist and index. */
  ninHash: string;
  status: NinVerificationStatus;
  /** Provider reference for dispute/audit; never contains the NIN. */
  providerReference: string | null;
  /** ISO-8601 timestamp of the check. */
  checkedAt: string;
};

/**
 * Strips whitespace and dashes a user may type, then validates the 11-digit
 * shape. Returns null for anything that cannot be a NIN so callers can reject
 * before spending a provider call.
 */
export function normalizeNin(nin: string | null | undefined): string | null {
  if (!nin) return null;
  const digits = nin.replace(/[\s-]/g, "");
  return NIN_PATTERN.test(digits) ? digits : null;
}

/**
 * Keyed hash of a normalized NIN. The domain-separation prefix keeps this
 * value from ever colliding with another HMAC use of the same secret.
 */
export function hashNin(pepper: string, normalizedNin: string): string {
  return createHmac("sha256", pepper)
    .update(`lafiya-nin-v1:${normalizedNin}`)
    .digest("hex");
}

/** Constant-time comparison of two stored NIN hashes. */
export function ninHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Reads the NIN pepper from runtime config. Returns null when NIN
 * verification is not configured, so callers can fail closed (hide the
 * feature) instead of hashing with an empty key.
 */
export function getNinPepper(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = getRuntimeConfig(env);
  if (!config.ninVerification.enabled) return null;
  return env.NIN_VERIFICATION_HMAC_SECRET ?? null;}

/**
 * Maps a provider response to a stored result. Anything other than an
 * explicit match is recorded as `not_verified`; transport/5xx failures are
 * `unavailable` so a retry is possible without implying a negative identity
 * claim about the person.
 */
export function buildNinVerificationResult(input: {
  pepper: string;
  nin: string;
  provider: {
    matched: boolean | null;
    reference?: string | null;
  };
  checkedAt?: Date;
}): NinVerificationResult {
  const normalized = normalizeNin(input.nin);
  if (!normalized) throw new Error("INVALID_NIN");
  const status: NinVerificationStatus =
    input.provider.matched === true
      ? "verified"
      : input.provider.matched === false
        ? "not_verified"
        : "unavailable";
  return {
    ninHash: hashNin(input.pepper, normalized),
    status,
    providerReference: input.provider.reference ?? null,
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
  };
}
