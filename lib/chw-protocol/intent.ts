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

/**
 * Reference model of the CHW verification intent state machine.
 *
 * This is the single source of truth for the states, the commands that may be
 * applied to them, and the invariants that must hold after every transition.
 * It is intentionally pure (no I/O, no database, no clock) so that it can be
 * driven by `fast-check` model-based tests in `lib/chw-protocol/intent.model.test.ts`
 * and reused by the workflow layer without duplicating the transition table.
 *
 * Invariants (checked after every command):
 *  - No double settlement: a settled intent can never be settled again.
 *  - Terminal states are absorbing: `settled`, `invalidated`, and `quarantined`
 *    accept no further commands.
 *  - Every transition is valid: only the transitions listed in
 *    `INTENT_TRANSITIONS` are permitted; anything else throws `ProtocolError`.
 */
export type IntentState =
  | "created"
  | "observed"
  | "finalized"
  | "invalidated"
  | "quarantined"
  | "released"
  | "settled";

export type IntentCommand =
  | "create"
  | "attest-observed"
  | "finalize"
  | "invalidate"
  | "quarantine"
  | "release"
  | "settle";

/** Terminal states absorb every command; no transition may leave them. */
export const INTENT_TERMINAL_STATES: readonly IntentState[] = [
  "settled",
  "invalidated",
  "quarantined",
];

/**
 * Allowed transitions for the CHW verification intent state machine.
 * `create` is the only command that produces the initial `created` state and
 * is therefore not listed as a transition target.
 */
export const INTENT_TRANSITIONS: Readonly<
  Record<IntentState, Partial<Record<IntentCommand, IntentState>>>
> = {
  created: {
    "attest-observed": "observed",
    invalidate: "invalidated",
    quarantine: "quarantined",
  },
  observed: {
    finalize: "finalized",
    invalidate: "invalidated",
    quarantine: "quarantined",
  },
  finalized: {
    settle: "settled",
    invalidate: "invalidated",
    quarantine: "quarantined",
  },
  released: {
    finalize: "finalized",
    invalidate: "invalidated",
    quarantine: "quarantined",
  },
  invalidated: {},
  quarantined: {
    release: "released",
  },
  settled: {},
};

/** True when the state is terminal and must absorb all further commands. */
export function isTerminalIntentState(state: IntentState): boolean {
  return INTENT_TERMINAL_STATES.includes(state);
}

/**
 * Applies a command to a state, returning the next state.
 *
 * Throws `ProtocolError("INVALID_TRANSITION")` when the command is not allowed
 * from the current state, which is exactly the invariant the model-based tests
 * assert: no double settlement, terminal states are absorbing, and every
 * transition is valid.
 */
export function applyIntentCommand(
  state: IntentState,
  command: IntentCommand,
): IntentState {
  if (command === "create") {
    if (state !== "created") throw new ProtocolError("INVALID_TRANSITION");
    return "created";
  }
  const next = INTENT_TRANSITIONS[state][command];
  if (!next) throw new ProtocolError("INVALID_TRANSITION");
  return next;
}
