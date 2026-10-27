import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Walk-in registration with deferred patient claim (issue #770).
 *
 * A CHW registers a patient who has no email or smartphone yet. The card is
 * created in a "pending_claim" state owned by a custodial placeholder, and a
 * single-use claim code (plus optional printed PIN) is handed to the
 * patient. Once the patient proves control of a phone number or email via
 * OTP and presents the code, ownership transfers atomically and every
 * custodial grant is revoked.
 *
 * Only an HMAC of the code is stored. The store is injected so the same
 * logic backs the Postgres implementation (see the
 * `walk_in_claims` migration) and the in-memory one used by tests.
 */

/** Unambiguous alphabet (no 0/O, 1/I/L) for codes read aloud or printed. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CLAIM_CODE_LENGTH = 10;
export const CLAIM_PIN_LENGTH = 6;
export const DEFAULT_CLAIM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_CLAIM_ATTEMPTS = 5;

/** Fields a CHW may capture for a walk-in; everything else waits for the patient. */
export const WALK_IN_FIELD_ALLOWLIST = Object.freeze([
  "name",
  "age",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
  "emergency_contacts",
  "language",
] as const);

export type WalkInField = (typeof WALK_IN_FIELD_ALLOWLIST)[number];

export interface PendingClaim {
  cardId: string;
  custodianId: string;
  codeHash: string;
  pinHash: string | null;
  expiresAt: number;
  attempts: number;
  claimedBy: string | null;
  claimedAt: number | null;
}

export interface WalkInClaimStore {
  insert(claim: PendingClaim): Promise<void>;
  findByCodeHash(codeHash: string): Promise<PendingClaim | null>;
  incrementAttempts(cardId: string): Promise<void>;
  /**
   * Atomically marks the claim used, sets `owner = patientId` on the card and
   * deletes every custodial grant. Must return false (and change nothing) if
   * the claim was already used, so concurrent redemptions cannot both win.
   */
  transferOwnership(
    cardId: string,
    patientId: string,
    now: number,
  ): Promise<boolean>;
  /** Deletes unclaimed cards whose claim expired before `now`; returns how many. */
  purgeExpired(now: number): Promise<number>;
}

export type Clock = () => number;

export type ClaimErrorCode =
  | "INVALID_CODE"
  | "EXPIRED"
  | "ALREADY_CLAIMED"
  | "TOO_MANY_ATTEMPTS"
  | "PIN_REQUIRED"
  | "OTP_NOT_VERIFIED";

export class ClaimError extends Error {
  constructor(readonly code: ClaimErrorCode) {
    super(code);
    this.name = "ClaimError";
  }
}

function randomCode(length: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function normalizeClaimCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function hashClaimSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(normalizeClaimCode(secret))
    .digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Keeps only CHW-capturable fields so a walk-in card never holds more than the minimum. */
export function pickWalkInFields(
  input: Record<string, unknown>,
): Partial<Record<WalkInField, unknown>> {
  const out: Partial<Record<WalkInField, unknown>> = {};
  for (const field of WALK_IN_FIELD_ALLOWLIST) {
    if (input[field] !== undefined) out[field] = input[field];
  }
  return out;
}

export interface WalkInClaimDeps {
  store: WalkInClaimStore;
  pepper: string;
  clock?: Clock;
  ttlMs?: number;
}

export async function issueClaim(
  deps: WalkInClaimDeps,
  cardId: string,
  custodianId: string,
  opts: { withPin?: boolean } = {},
): Promise<{ code: string; pin: string | null; expiresAt: number }> {
  const now = (deps.clock ?? Date.now)();
  const code = randomCode(CLAIM_CODE_LENGTH, CODE_ALPHABET);
  const pin = opts.withPin ? randomCode(CLAIM_PIN_LENGTH, "0123456789") : null;
  const expiresAt = now + (deps.ttlMs ?? DEFAULT_CLAIM_TTL_MS);
  await deps.store.insert({
    cardId,
    custodianId,
    codeHash: hashClaimSecret(code, deps.pepper),
    pinHash: pin ? hashClaimSecret(pin, deps.pepper) : null,
    expiresAt,
    attempts: 0,
    claimedBy: null,
    claimedAt: null,
  });
  return { code, pin, expiresAt };
}

/**
 * Redeems a claim code for a patient whose phone/email OTP has already been
 * verified by the caller (see `supabaseEmailOtp` / phone OTP actions).
 * Per-client rate limiting is applied upstream with `lib/rate-limit.ts`;
 * the per-claim attempt counter here protects a single code from guessing.
 */
export async function redeemClaim(
  deps: WalkInClaimDeps,
  input: {
    code: string;
    pin?: string;
    patientId: string;
    otpVerified: boolean;
  },
): Promise<{ cardId: string }> {
  if (!input.otpVerified) throw new ClaimError("OTP_NOT_VERIFIED");
  const now = (deps.clock ?? Date.now)();
  const claim = await deps.store.findByCodeHash(
    hashClaimSecret(input.code, deps.pepper),
  );
  if (!claim) throw new ClaimError("INVALID_CODE");
  if (claim.claimedBy) throw new ClaimError("ALREADY_CLAIMED");
  if (claim.expiresAt <= now) throw new ClaimError("EXPIRED");
  if (claim.attempts >= MAX_CLAIM_ATTEMPTS)
    throw new ClaimError("TOO_MANY_ATTEMPTS");
  if (claim.pinHash) {
    const ok =
      input.pin !== undefined &&
      hashesEqual(claim.pinHash, hashClaimSecret(input.pin, deps.pepper));
    if (!ok) {
      await deps.store.incrementAttempts(claim.cardId);
      throw new ClaimError("PIN_REQUIRED");
    }
  }
  const won = await deps.store.transferOwnership(
    claim.cardId,
    input.patientId,
    now,
  );
  if (!won) throw new ClaimError("ALREADY_CLAIMED");
  return { cardId: claim.cardId };
}

export function purgeExpiredClaims(deps: WalkInClaimDeps): Promise<number> {
  return deps.store.purgeExpired((deps.clock ?? Date.now)());
}
