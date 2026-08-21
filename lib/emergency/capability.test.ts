import { describe, expect, it } from "vitest";

import {
  CAPABILITY_TOKEN_PATTERN,
  createRawCapability,
  digestCapability,
  isCapabilityToken,
} from "./capability";

describe("emergency capability protocol", () => {
  it("issues URL-safe versioned 256-bit capabilities and persists only a one-way digest", () => {
    const first = createRawCapability();
    const second = createRawCapability();
    expect(first).toMatch(CAPABILITY_TOKEN_PATTERN);
    expect(second).toMatch(CAPABILITY_TOKEN_PATTERN);
    expect(first).not.toBe(second);
    expect(digestCapability(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestCapability(first)).not.toContain(first);
  });

  it("rejects malformed values before they reach the database resolver", () => {
    expect(isCapabilityToken("lafiya_e1_short")).toBe(false);
    expect(isCapabilityToken("11111111-1111-1111-1111-111111111111")).toBe(
      false,
    );
    expect(() => digestCapability("lafiya_e1_short")).toThrow(
      "INVALID_CAPABILITY",
    );
  });
});
