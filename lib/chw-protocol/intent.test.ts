import { describe, expect, it } from "vitest";

import { signAttestationIntent, verifyAttestationIntent } from "./intent";
import { ProtocolError, type AttestationIntentPayload } from "./types";

const SIGNING_KEY = "test-signing-key";

function payload(
  overrides: Partial<AttestationIntentPayload> = {},
): AttestationIntentPayload {
  return {
    version: 1,
    intentId: "intent-1",
    requestId: "request-1",
    revisionId: "revision-1",
    recordCommitment: "commitment-hash",
    schemaVersion: 1,
    chwId: "chw-1",
    stellarAddress: "GCHW",
    epoch: {
      id: "epoch-1",
      networkPassphraseHash: "hash",
      contractId: "contract-1",
      contractVersion: "1",
      eventVersion: 1,
    },
    idempotencyKey: "idem-1",
    issuedAt: "2026-08-30T00:00:00.000Z",
    expiresAt: "2026-08-30T00:05:00.000Z",
    ...overrides,
  };
}

describe("chw-protocol intent lifecycle — valid transitions", () => {
  it("signs then verifies an intent within its validity window (start -> complete)", () => {
    const intent = signAttestationIntent(payload(), SIGNING_KEY);
    const verified = verifyAttestationIntent(
      intent,
      SIGNING_KEY,
      new Date("2026-08-30T00:01:00.000Z"),
    );
    expect(verified.intentId).toBe("intent-1");
  });
});

describe("chw-protocol intent lifecycle — invalid transitions", () => {
  it("rejects completing (verifying) an intent that was never started (never signed)", () => {
    // A payload that was fabricated client-side and never actually produced
    // by signAttestationIntent — the "not yet registered" analog for this
    // state machine: there is no prior START event to complete.
    const neverSigned = { payload: payload(), signature: "not-a-real-signature" };
    expect(() => verifyAttestationIntent(neverSigned, SIGNING_KEY)).toThrow(
      ProtocolError,
    );
    expect(() => verifyAttestationIntent(neverSigned, SIGNING_KEY)).toThrow(
      /INVALID_INTENT/,
    );
  });

  it("rejects completing an intent signed under a different (never-issued) signing key", () => {
    const intent = signAttestationIntent(payload(), SIGNING_KEY);
    expect(() =>
      verifyAttestationIntent(intent, "a-different-signing-key"),
    ).toThrow(ProtocolError);
    try {
      verifyAttestationIntent(intent, "a-different-signing-key");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("INVALID_INTENT");
    }
  });

  it("rejects completing an intent whose payload was tampered with after being started", () => {
    const intent = signAttestationIntent(payload(), SIGNING_KEY);
    const tampered = {
      ...intent,
      payload: { ...intent.payload, stellarAddress: "GATTACKER" },
    };
    expect(() => verifyAttestationIntent(tampered, SIGNING_KEY)).toThrow(
      ProtocolError,
    );
  });

  it("rejects completing an intent whose validity window has already elapsed (attempting to finish something already timed out, not merely never-started)", () => {
    const intent = signAttestationIntent(payload(), SIGNING_KEY);
    expect(() =>
      verifyAttestationIntent(
        intent,
        SIGNING_KEY,
        new Date("2026-08-30T00:10:00.000Z"),
      ),
    ).toThrow(ProtocolError);
    try {
      verifyAttestationIntent(
        intent,
        SIGNING_KEY,
        new Date("2026-08-30T00:10:00.000Z"),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("INTENT_EXPIRED");
    }
  });

  it("rejects starting (signing) an intent with no signing key configured", () => {
    expect(() => signAttestationIntent(payload(), "")).toThrow(ProtocolError);
    try {
      signAttestationIntent(payload(), "");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("INVALID_INTENT");
    }
  });

  it("rejects completing a malformed/incomplete intent object (missing payload or signature)", () => {
    // @ts-expect-error — intentionally malformed input
    expect(() => verifyAttestationIntent({ signature: "x" }, SIGNING_KEY)).toThrow(
      ProtocolError,
    );
    expect(() =>
      // @ts-expect-error — intentionally malformed input
      verifyAttestationIntent({ payload: payload() }, SIGNING_KEY),
    ).toThrow(ProtocolError);
  });

  it("rejects completing an intent whose version has been superseded", () => {
    const intent = signAttestationIntent(payload(), SIGNING_KEY);
    const wrongVersion = {
      ...intent,
      // @ts-expect-error — intentionally invalid version to simulate a
      // superseded/unsupported schema being replayed against this verifier
      payload: { ...intent.payload, version: 2 },
    };
    expect(() => verifyAttestationIntent(wrongVersion, SIGNING_KEY)).toThrow(
      ProtocolError,
    );
  });
});
