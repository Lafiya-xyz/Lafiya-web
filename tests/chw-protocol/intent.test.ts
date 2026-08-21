import { describe, expect, it } from "vitest";

import {
  signAttestationIntent,
  verifyAttestationIntent,
} from "@/lib/chw-protocol/intent";
import { ProtocolError } from "@/lib/chw-protocol/types";

const payload = {
  version: 1 as const,
  intentId: "00000000-0000-0000-0000-000000000001",
  requestId: "00000000-0000-0000-0000-000000000002",
  revisionId: "00000000-0000-0000-0000-000000000003",
  recordCommitment: "a".repeat(64),
  schemaVersion: 1,
  chwId: "00000000-0000-0000-0000-000000000004",
  stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  epoch: {
    id: "00000000-0000-0000-0000-000000000005",
    networkPassphraseHash: "b".repeat(64),
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    contractVersion: "1.0.0",
    eventVersion: 1,
  },
  idempotencyKey: "00000000-0000-0000-0000-000000000006",
  issuedAt: "2026-08-21T00:00:00.000Z",
  expiresAt: "2026-08-21T00:05:00.000Z",
};

describe("signed attestation intents", () => {
  it("is deterministic regardless of input object key order", () => {
    const signed = signAttestationIntent(payload, "test-signing-key");
    expect(
      verifyAttestationIntent(
        signed,
        "test-signing-key",
        new Date("2026-08-21T00:01:00.000Z"),
      ),
    ).toEqual(payload);
  });

  it("fails closed for a modified binding, wrong key, or expired intent", () => {
    const signed = signAttestationIntent(payload, "test-signing-key");
    expect(() =>
      verifyAttestationIntent(
        { ...signed, payload: { ...signed.payload, stellarAddress: "GOTHER" } },
        "test-signing-key",
        new Date("2026-08-21T00:01:00.000Z"),
      ),
    ).toThrow(ProtocolError);
    expect(() =>
      verifyAttestationIntent(
        signed,
        "another-key",
        new Date("2026-08-21T00:01:00.000Z"),
      ),
    ).toThrow("INVALID_INTENT");
    expect(() =>
      verifyAttestationIntent(
        signed,
        "test-signing-key",
        new Date("2026-08-21T00:05:00.000Z"),
      ),
    ).toThrow("INTENT_EXPIRED");
  });
});
