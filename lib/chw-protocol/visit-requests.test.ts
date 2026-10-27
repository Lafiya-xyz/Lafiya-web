import { describe, expect, it } from "vitest";

import {
  InvalidVisitTransitionError,
  VISIT_REQUEST_STATUSES,
  anonymizeVisitRequest,
  canTransitionVisit,
  chwQueue,
  transitionVisit,
  type VisitRequest,
} from "./visit-requests";

const request = (overrides: Partial<VisitRequest> = {}): VisitRequest => ({
  id: "r1",
  status: "requested",
  lga: "ikeja",
  preferred_language: "yo",
  contact_preference: "sms",
  contact_consent: true,
  contact_phone: "+2348000000000",
  matched_chw_id: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("verification visit state machine", () => {
  it("allows the happy path", () => {
    let status = transitionVisit("requested", "matched");
    status = transitionVisit(status, "scheduled");
    expect(transitionVisit(status, "verified")).toBe("verified");
  });

  it.each([
    ["requested", "scheduled"],
    ["requested", "verified"],
    ["matched", "verified"],
    ["scheduled", "requested"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(() => transitionVisit(from, to)).toThrow(
      InvalidVisitTransitionError,
    );
  });

  it("treats closed states as terminal", () => {
    for (const from of ["verified", "declined", "expired"] as const) {
      for (const to of VISIT_REQUEST_STATUSES) {
        expect(canTransitionVisit(from, to)).toBe(false);
      }
    }
  });
});

describe("chwQueue", () => {
  it("shows only requests in the CHW's assigned area", () => {
    const queue = chwQueue(
      [request(), request({ id: "r2", lga: "kano-municipal" })],
      "chw-1",
      ["ikeja"],
    );
    expect(queue.map((q) => q.id)).toEqual(["r1"]);
  });

  it("reveals contact only to the matched CHW with consent", () => {
    const matched = request({ status: "matched", matched_chw_id: "chw-1" });
    expect(chwQueue([matched], "chw-1", ["ikeja"])[0]?.contact_phone).toBe(
      "+2348000000000",
    );
    expect(
      chwQueue([matched], "chw-2", ["ikeja"])[0]?.contact_phone,
    ).toBeNull();
    expect(
      chwQueue([{ ...matched, contact_consent: false }], "chw-1", ["ikeja"])[0]
        ?.contact_phone,
    ).toBeNull();
  });

  it("hides closed requests", () => {
    expect(
      chwQueue([request({ status: "verified" })], "chw-1", ["ikeja"]),
    ).toEqual([]);
  });
});

describe("anonymizeVisitRequest", () => {
  it("strips contact details once closed", () => {
    const closed = anonymizeVisitRequest(
      request({ status: "declined", matched_chw_id: "c" }),
    );
    expect(closed.contact_phone).toBeNull();
    expect(closed.matched_chw_id).toBeNull();
    expect(closed.contact_consent).toBe(false);
  });

  it("leaves open requests untouched", () => {
    const open = request();
    expect(anonymizeVisitRequest(open)).toEqual(open);
  });
});
