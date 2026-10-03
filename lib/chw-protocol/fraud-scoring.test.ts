import { describe, expect, it } from "vitest";
import {
  detectBurstVelocity,
  detectNearDuplicates,
  detectSharedDeviceOrIp,
  type VerificationIntentSignal,
} from "./fraud-scoring";

function intent(overrides: Partial<VerificationIntentSignal>): VerificationIntentSignal {
  return {
    chwId: "chw-1",
    intentId: crypto.randomUUID(),
    revisionId: "rev-1",
    issuedAt: new Date("2026-09-28T10:00:00Z"),
    ...overrides,
  };
}

describe("detectBurstVelocity", () => {
  it("flags a CHW submitting more than the threshold within one hour bucket", () => {
    const intents = Array.from({ length: 10 }, (_, i) =>
      intent({ intentId: `i${i}`, issuedAt: new Date(`2026-09-28T10:0${i % 6}:00Z`) }),
    );
    const findings = detectBurstVelocity(intents, 8);
    expect(findings).toHaveLength(1);
    expect(findings[0].chwId).toBe("chw-1");
    expect(findings[0].evidence.intentsInHour).toBe(10);
  });

  it("does not flag normal submission rates (synthetic non-fraud fixture)", () => {
    const intents = Array.from({ length: 3 }, (_, i) =>
      intent({ intentId: `i${i}`, issuedAt: new Date(`2026-09-28T${10 + i}:00:00Z`) }),
    );
    expect(detectBurstVelocity(intents, 8)).toHaveLength(0);
  });
});

describe("detectSharedDeviceOrIp", () => {
  it("flags two distinct CHWs sharing the same device_id", () => {
    const intents = [
      intent({ chwId: "chw-a", deviceId: "device-x" }),
      intent({ chwId: "chw-b", deviceId: "device-x" }),
    ];
    const findings = detectSharedDeviceOrIp(intents, 2);
    expect(findings.map((f) => f.chwId).sort()).toEqual(["chw-a", "chw-b"]);
  });

  it("does not flag a single CHW using one device across many intents", () => {
    const intents = [
      intent({ chwId: "chw-a", deviceId: "device-x", intentId: "1" }),
      intent({ chwId: "chw-a", deviceId: "device-x", intentId: "2" }),
    ];
    expect(detectSharedDeviceOrIp(intents, 2)).toHaveLength(0);
  });

  it("falls back to ip_address clustering when device_id is absent", () => {
    const intents = [
      intent({ chwId: "chw-a", ipAddress: "10.0.0.1" }),
      intent({ chwId: "chw-b", ipAddress: "10.0.0.1" }),
      intent({ chwId: "chw-c", ipAddress: "10.0.0.1" }),
    ];
    const findings = detectSharedDeviceOrIp(intents, 2);
    expect(findings).toHaveLength(3);
    expect(findings[0].evidence.distinctChwCount).toBe(3);
  });
});

describe("detectNearDuplicates", () => {
  it("flags a resubmission of the same revision within the window", () => {
    const intents = [
      intent({ intentId: "first", revisionId: "rev-9", issuedAt: new Date("2026-09-28T10:00:00Z") }),
      intent({ intentId: "second", revisionId: "rev-9", issuedAt: new Date("2026-09-28T10:03:00Z") }),
    ];
    const findings = detectNearDuplicates(intents, 10);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.intentId).toBe("second");
    expect(findings[0].evidence.duplicateOfIntentId).toBe("first");
  });

  it("does not flag two submissions for the same revision far apart in time", () => {
    const intents = [
      intent({ intentId: "first", revisionId: "rev-9", issuedAt: new Date("2026-09-28T10:00:00Z") }),
      intent({ intentId: "second", revisionId: "rev-9", issuedAt: new Date("2026-09-28T14:00:00Z") }),
    ];
    expect(detectNearDuplicates(intents, 10)).toHaveLength(0);
  });
});
