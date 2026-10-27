import { describe, expect, it } from "vitest";

import {
  DEFAULT_HANDOVER_POLICY,
  hasReachedMajority,
  initialHandover,
  majorityDate,
  transitionHandover,
} from "./guardianHandover";

const DOB = "2008-06-15";
const notify = (now: Date) =>
  transitionHandover(initialHandover(), {
    type: "tick",
    dateOfBirth: DOB,
    now,
  });

describe("guardian handover at age of majority (issue #769)", () => {
  it("ends guardian control exactly at local midnight across time zones", () => {
    // 2026-06-14T23:00Z is already 2026-06-15 00:00 in Lagos (UTC+1).
    expect(hasReachedMajority(DOB, new Date("2026-06-14T22:59:59Z"))).toBe(
      false,
    );
    expect(hasReachedMajority(DOB, new Date("2026-06-14T23:00:00Z"))).toBe(
      true,
    );
    const ny = { ...DEFAULT_HANDOVER_POLICY, timeZone: "America/New_York" };
    expect(hasReachedMajority(DOB, new Date("2026-06-15T03:59:59Z"), ny)).toBe(
      false,
    );
    expect(hasReachedMajority(DOB, new Date("2026-06-15T04:00:00Z"), ny)).toBe(
      true,
    );
    expect(majorityDate("2008-02-29", 18)).toBe("2026-03-01");
  });

  it("supports a configurable jurisdictional age", () => {
    const p = { ...DEFAULT_HANDOVER_POLICY, majorityAge: 21 };
    expect(hasReachedMajority(DOB, new Date("2027-01-01T00:00:00Z"), p)).toBe(
      false,
    );
  });

  it("claim path: dependant chooses what the guardian keeps", () => {
    const n = notify(new Date("2026-06-15T12:00:00Z"));
    expect(n).toMatchObject({ state: "notified", guardianAccess: "read_only" });
    const c = transitionHandover(n, {
      type: "claim",
      now: new Date("2026-06-16T00:00:00Z"),
      keepGuardian: "read_only",
    });
    expect(c.state).toBe("claimed");
    expect(c.consent.map((r) => [r.grantedBy, r.guardianAccess])).toEqual([
      ["guardian", "read_only"],
      ["dependant", "read_only"],
    ]);
  });

  it("decline path revokes guardian access", () => {
    const n = notify(new Date("2026-06-15T12:00:00Z"));
    const d = transitionHandover(n, { type: "decline", now: new Date() });
    expect(d).toMatchObject({ state: "declined", guardianAccess: "none" });
  });

  it("timeout path revokes guardian access after the claim window", () => {
    const at = new Date("2026-06-15T12:00:00Z");
    const n = notify(at);
    const early = new Date(at.getTime() + 29 * 86_400_000);
    const late = new Date(at.getTime() + 30 * 86_400_000);
    const tick = (now: Date) =>
      transitionHandover(
        n,
        { type: "tick", dateOfBirth: DOB, now },
        DEFAULT_HANDOVER_POLICY,
        at,
      );
    expect(tick(early).state).toBe("notified");
    expect(tick(late)).toMatchObject({
      state: "timed_out",
      guardianAccess: "none",
    });
  });
});
