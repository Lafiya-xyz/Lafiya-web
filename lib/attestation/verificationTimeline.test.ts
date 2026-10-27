import { describe, expect, it } from "vitest";

import {
  buildVerificationTimeline,
  TRANSITION_MESSAGES,
  type AttestationEvent,
} from "./verificationTimeline";

const attested: AttestationEvent = {
  kind: "attested",
  at: "2026-01-01T00:00:00Z",
  recordVersion: 1,
  verifierName: "Dr Ade",
  verifierOrganization: "Ikeja Clinic",
};

describe("verification timeline (issue #766)", () => {
  it("has an explanation string for every transition type", () => {
    for (const fn of Object.values(TRANSITION_MESSAGES.en))
      expect(fn(null).length).toBeGreaterThan(0);
  });

  it("explains verification and revocation", () => {
    const t = buildVerificationTimeline(
      [attested, { ...attested, kind: "revoked", at: "2026-02-01T00:00:00Z" }],
      [],
      "named",
    );
    expect(t.map((e) => e.type)).toEqual(["verified", "revoked"]);
    expect(t[0].message).toContain("Dr Ade");
  });

  it("flags verification that no longer matches the latest edit", () => {
    const t = buildVerificationTimeline(
      [attested],
      [{ version: 2, at: "2026-03-01T00:00:00Z" }],
      "named",
    );
    expect(t.at(-1)).toMatchObject({
      type: "stale_after_edit",
      canRequestReverification: true,
    });
  });

  it("respects the verifier display policy", () => {
    expect(
      buildVerificationTimeline([attested], [], "hidden")[0].verifier,
    ).toBe(null);
    expect(
      buildVerificationTimeline([attested], [], "organization")[0].verifier,
    ).toBe("Ikeja Clinic");
  });

  it("shows eventual-consistency messaging for unindexed events", () => {
    const t = buildVerificationTimeline(
      [{ ...attested, indexed: false }],
      [{ version: 2, at: "2026-03-01T00:00:00Z" }],
      "named",
    );
    expect(t.map((e) => e.type)).toEqual(["pending_index"]);
  });
});
