import "server-only";

import {
  argon2,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

import type { DisclosurePolicy } from "@/lib/supabase/types";

/**
 * Issue #631: fields a patient may put behind the printed card PIN.
 *
 * Everything else (name, age, blood group, genotype, allergies, emergency
 * contacts, language) is life-critical for a responder and can never be
 * PIN-gated. The same list is enforced in SQL (public.card_pin_gated_fields).
 * PENDING CLINICAL REVIEW: medications are included because some (e.g.
 * antiretrovirals) disclose a stigmatised diagnosis, but a clinician must
 * confirm this before the feature is enabled for patients.
 */
export const PIN_GATEABLE_FIELDS = [
  "photo_url",
  "medications",
  "chronic_conditions",
] as const;
export type PinGateableField = (typeof PIN_GATEABLE_FIELDS)[number];

export const CARD_PIN_PATTERN = /^[0-9]{6}$/;
export const CARD_PIN_MAX_ATTEMPTS = 5;
export const CARD_PIN_UNLOCK_SECONDS = 15 * 60;
export const CARD_PIN_COOKIE = "lafiya_card_pin";

// OWASP-recommended Argon2id parameters (19 MiB, 2 passes, 1 lane).
const ARGON2_PARAMS = { memory: 19456, passes: 2, parallelism: 1 } as const;
const ARGON2_TAG_LENGTH = 32;

export function isPinGateableField(field: string): field is PinGateableField {
  return (PIN_GATEABLE_FIELDS as readonly string[]).includes(field);
}

/** The patient's PIN-gated fields, restricted to the gateable allowlist. */
export function pinGatedFields(policy: DisclosurePolicy): PinGateableField[] {
  return [...new Set(policy.requires_card_pin ?? [])].filter(
    isPinGateableField,
  );
}

/** Uniformly random 6-digit PIN (leading zeros allowed). */
export function generateCardPin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function argon2id(
  pin: string,
  nonce: Buffer,
  params: { memory: number; passes: number; parallelism: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      "argon2id",
      { message: pin, nonce, tagLength: ARGON2_TAG_LENGTH, ...params },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    ),
  );
}

/** PHC-format Argon2id hash; the only form of the PIN ever persisted. */
export async function hashCardPin(pin: string): Promise<string> {
  if (!CARD_PIN_PATTERN.test(pin)) throw new Error("INVALID_CARD_PIN");
  const salt = randomBytes(16);
  const hash = await argon2id(pin, salt, ARGON2_PARAMS);
  const { memory, passes, parallelism } = ARGON2_PARAMS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyCardPin(
  pin: string,
  encoded: string,
): Promise<boolean> {
  if (!CARD_PIN_PATTERN.test(pin)) return false;
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
      encoded,
    );
  if (!match) return false;
  const expected = Buffer.from(match[5], "base64url");
  const actual = await argon2id(pin, Buffer.from(match[4], "base64url"), {
    memory: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Random unlock-session value for the cookie; only its digest is stored. */
export function createUnlockToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestUnlockToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Withholds PIN-gated fields from a card projection. Their disclosure state
 * becomes "pin_required" so the card explains why they are hidden.
 */
export function withholdPinGatedFields<
  T extends { disclosure_states: Record<string, string> | null },
>(card: T, gatedFields: readonly string[]): T {
  const gated = gatedFields.filter(isPinGateableField);
  if (gated.length === 0) return card;
  const redacted: Record<string, unknown> = { ...card };
  const states = { ...(card.disclosure_states ?? {}) };
  for (const field of gated) {
    const hadValue = redacted[field] !== null && redacted[field] !== undefined;
    if (hadValue || states[field] === "disclosed") {
      states[field] = "pin_required";
    }
    redacted[field] = null;
  }
  redacted.disclosure_states = states;
  return redacted as T;
}
