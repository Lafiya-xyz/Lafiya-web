import { describe, expect, it } from "vitest";

import {
  lockoutSeconds,
  stepFrequency,
  stepRateLimit,
} from "./rate-limit-model";

describe("lockoutSeconds", () => {
  it("encodes the documented schedule boundaries", () => {
    expect(lockoutSeconds(4)).toBeNull();
    expect(lockoutSeconds(5)).toBe(30);
    expect(lockoutSeconds(6)).toBe(60);
    expect(lockoutSeconds(9)).toBe(480);
    expect(lockoutSeconds(10)).toBe(900);
    expect(lockoutSeconds(50)).toBe(900);
  });
});

describe("stepRateLimit", () => {
  it("resets only on success, not on elapsed time", () => {
    let state = stepRateLimit({ attempts: null }, { kind: "failure" });
    state = stepRateLimit(state, { kind: "advance", seconds: 10_000 });
    expect(stepRateLimit(state, { kind: "failure" }).attempts).toBe(2);
    expect(stepRateLimit(state, { kind: "success" }).attempts).toBeNull();
  });
});

describe("stepFrequency", () => {
  it("rejects past the cap and reopens the window once it fully elapses", () => {
    let state = { elapsed: null as number | null, count: 0 };
    for (let i = 0; i < 3; i++)
      state = stepFrequency(state, { kind: "hit" }, 3, 60).state;
    const rejected = stepFrequency(state, { kind: "hit" }, 3, 60);
    expect(rejected.result).toEqual({
      allowed: false,
      count: 4,
      retryAfterSeconds: 60,
    });

    state = stepFrequency(
      rejected.state,
      { kind: "advance", seconds: 59 },
      3,
      60,
    ).state;
    expect(
      stepFrequency(state, { kind: "hit" }, 3, 60).result?.retryAfterSeconds,
    ).toBe(1);
    state = stepFrequency(state, { kind: "advance", seconds: 1 }, 3, 60).state;
    expect(stepFrequency(state, { kind: "hit" }, 3, 60).result?.count).toBe(1);
  });
});
