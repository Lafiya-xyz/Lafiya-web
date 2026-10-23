import { describe, expect, it } from "vitest";

import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  OUTBOX_RETRY_POLICIES,
  computeOutboxBackoffMs,
  computeOutboxNextAttemptAt,
  getOutboxRetryPolicy,
} from "./backoff";

describe("outbox retry policy (#688)", () => {
  it("resolves per-event overrides and falls back to the default", () => {
    expect(
      getOutboxRetryPolicy("record_revision:record_saved", {
        "record_revision:record_saved": {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 1_000,
        },
      }),
    ).toEqual({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 });

    expect(getOutboxRetryPolicy("unknown:event")).toBe(
      DEFAULT_OUTBOX_RETRY_POLICY,
    );
    expect(getOutboxRetryPolicy("record_revision:record_saved")).toBe(
      OUTBOX_RETRY_POLICIES["record_revision:record_saved"],
    );
  });
});

describe("computeOutboxBackoffMs (#688)", () => {
  const policy = { maxAttempts: 6, baseDelayMs: 1_000, maxDelayMs: 8_000 };

  it("uses full jitter between zero and the exponential ceiling", () => {
    expect(computeOutboxBackoffMs(1, policy, () => 0)).toBe(0);
    expect(computeOutboxBackoffMs(1, policy, () => 0.5)).toBe(500);
    expect(computeOutboxBackoffMs(2, policy, () => 0.5)).toBe(1_000);
    expect(computeOutboxBackoffMs(3, policy, () => 0.5)).toBe(2_000);
    expect(computeOutboxBackoffMs(4, policy, () => 0.5)).toBe(4_000);
  });

  it("caps the ceiling at maxDelayMs", () => {
    expect(computeOutboxBackoffMs(5, policy, () => 0.999)).toBe(7_992);
    expect(computeOutboxBackoffMs(50, policy, () => 0.999)).toBe(7_992);
  });

  it("never returns NaN for a pathological attempts value", () => {
    const delay = computeOutboxBackoffMs(
      Number.POSITIVE_INFINITY,
      policy,
      () => 0.5,
    );
    expect(Number.isFinite(delay)).toBe(true);
  });

  it("clamps out-of-range jitter samples", () => {
    expect(computeOutboxBackoffMs(1, policy, () => 1)).toBe(1_000);
    expect(computeOutboxBackoffMs(1, policy, () => -1)).toBe(0);
    expect(computeOutboxBackoffMs(1, policy, () => Number.NaN)).toBe(0);
  });
});

describe("computeOutboxNextAttemptAt (#688)", () => {
  it("adds the jittered delay to the injected fake clock", () => {
    const now = Date.UTC(2026, 9, 23, 12, 0, 0);
    const policy = { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 };

    const first = computeOutboxNextAttemptAt(now, 1, policy, () => 0.5);
    expect(first.getTime()).toBe(now + 1_000);

    const second = computeOutboxNextAttemptAt(now, 2, policy, () => 0.5);
    expect(second.getTime()).toBe(now + 2_000);
  });

  it("is deterministic when the clock and jitter are injected", () => {
    const policy = { maxAttempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 };
    const run = () => computeOutboxNextAttemptAt(1_000, 3, policy, () => 0.25);
    expect(run().toISOString()).toBe(run().toISOString());
  });
});
