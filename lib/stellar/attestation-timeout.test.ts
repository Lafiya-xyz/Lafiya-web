import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockUnstableCache } from "@/tests/fixtures/next-cache";

void mockUnstableCache;

import {
  AttestationContractError,
  AttestationTimeoutError,
  classifyAttestationError,
  withTimeout,
} from "./attestation";

describe("withTimeout (Issue #691)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves zero pending timers after thousands of successful and failing lookups", async () => {
    for (let i = 0; i < 2000; i++) {
      await withTimeout(async () => i, 2000);
      await expect(
        withTimeout(async () => {
          throw new Error("network down");
        }, 2000),
      ).rejects.toThrow("network down");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the in-flight request on timeout and rejects with a timeout error", async () => {
    let captured: AbortSignal | undefined;
    const pending = withTimeout((signal) => {
      captured = signal;
      return new Promise(() => {});
    }, 100);
    const assertion = expect(pending).rejects.toBeInstanceOf(
      AttestationTimeoutError,
    );
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(captured?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the timeout / contract / network error taxonomy", () => {
    expect(classifyAttestationError(new AttestationTimeoutError())).toBe(
      "timeout",
    );
    expect(classifyAttestationError(new AttestationContractError("trap"))).toBe(
      "contract",
    );
    expect(classifyAttestationError(new Error("Circuit breaker is OPEN"))).toBe(
      "breaker_open",
    );
    expect(classifyAttestationError(new Error("ECONNRESET"))).toBe("network");
  });
});
