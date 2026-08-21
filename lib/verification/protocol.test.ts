import { describe, expect, it } from "vitest";

import {
  canonicalizeAttestationIntent,
  hashAttestationIntent,
  hashNetworkPassphrase,
  trustStatusCopy,
  validateAttestationIntent,
} from "./protocol";

const intent = {
  requestId: "request-id",
  revisionId: "revision-id",
  recordHash: "ab".repeat(32),
  schemaVersion: 1,
  networkPassphraseHash: "cd".repeat(32),
  contractId: "CABC",
  chwId: "chw-id",
  stellarAddress: "GABC",
  expiresAt: "2026-08-21T12:05:00.000Z",
};

describe("attestation intent", () => {
  it("canonicalizes and hashes the network/contract-pinned fields deterministically", () => {
    expect(canonicalizeAttestationIntent(intent)).toBe(
      canonicalizeAttestationIntent({ ...intent }),
    );
    expect(hashAttestationIntent(intent)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashNetworkPassphrase("Test SDF Network ; September 2015")).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("fails closed on expired or malformed intents", () => {
    expect(
      validateAttestationIntent(intent, new Date("2026-08-21T12:00:00Z")),
    ).toBeNull();
    expect(validateAttestationIntent({ ...intent, recordHash: "nope" })).toBe(
      "INVALID_RECORD_HASH",
    );
    expect(
      validateAttestationIntent(intent, new Date("2026-08-21T12:06:00Z")),
    ).toBe("INTENT_EXPIRED");
  });

  it("does not describe conflicted evidence as verified", () => {
    expect(trustStatusCopy("conflicted").label).toBe(
      "Verification unavailable",
    );
    expect(trustStatusCopy("verified").detail).toContain(
      "exact record revision",
    );
  });
});
