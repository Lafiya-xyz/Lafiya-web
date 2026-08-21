import { describe, expect, it } from "vitest";

import { resolveTrustState } from "@/lib/chw-protocol/trust";

const base = {
  requestCurrent: true,
  intentSubmitted: false,
  observed: false,
  finalized: false,
  revoked: false,
  expiresAt: null,
  providerConflict: false,
  providerAvailable: true,
};

describe("trust decision state machine", () => {
  it("never infers verification from submission or observation", () => {
    expect(resolveTrustState({ ...base, intentSubmitted: true })).toBe(
      "submitted",
    );
    expect(resolveTrustState({ ...base, observed: true })).toBe("confirming");
    expect(
      resolveTrustState({ ...base, observed: true, finalized: true }),
    ).toBe("verified");
  });

  it("makes loss of currentness, conflict, revocation, expiry, and outage explicit", () => {
    expect(
      resolveTrustState({ ...base, requestCurrent: false, finalized: true }),
    ).toBe("superseded");
    expect(
      resolveTrustState({ ...base, providerConflict: true, finalized: true }),
    ).toBe("conflicted");
    expect(resolveTrustState({ ...base, revoked: true, finalized: true })).toBe(
      "revoked",
    );
    expect(resolveTrustState({ ...base, providerAvailable: false })).toBe(
      "unavailable",
    );
    expect(
      resolveTrustState(
        { ...base, expiresAt: "2026-08-20T00:00:00.000Z", finalized: true },
        new Date("2026-08-21T00:00:00.000Z"),
      ),
    ).toBe("expired");
  });
});
