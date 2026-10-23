import { describe, expect, it } from "vitest";

import { MAX_OUTBOX_LAST_ERROR_LENGTH, sanitizeOutboxError } from "./error";

describe("sanitizeOutboxError (#688)", () => {
  it("redacts identifiers and credentials from error messages", () => {
    const sanitized = sanitizeOutboxError(
      new Error(
        "failed for 123e4567-e89b-42d3-a456-426614174000 " +
          "bearer Bearer super-secret token 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ),
    );

    expect(sanitized).not.toContain("123e4567-e89b-42d3-a456-426614174000");
    expect(sanitized).not.toContain("super-secret");
    expect(sanitized).not.toContain(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(sanitized).toContain("[REDACTED_ID]");
  });

  it("normalises whitespace and truncates to the database bound", () => {
    const sanitized = sanitizeOutboxError(
      `line one\nline two\t${"x".repeat(1_000)}`,
    );
    expect(sanitized).not.toContain("\n");
    expect(sanitized).not.toContain("\t");
    expect(sanitized.length).toBeLessThanOrEqual(MAX_OUTBOX_LAST_ERROR_LENGTH);
  });

  it("falls back to a stable message for non-error values", () => {
    expect(sanitizeOutboxError(null)).toBe("outbox handler failed");
    expect(sanitizeOutboxError({})).toBe("outbox handler failed");
  });
});
