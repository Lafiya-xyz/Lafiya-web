import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime } from "./datetime";

describe("formatDateTime", () => {
  it("formats a valid ISO string with a date and time", () => {
    const result = formatDateTime("2026-01-05T15:45:00Z");
    expect(result).not.toBe("Unavailable");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns the fallback for null", () => {
    expect(formatDateTime(null)).toBe("Unavailable");
  });

  it("returns the fallback for undefined", () => {
    expect(formatDateTime(undefined)).toBe("Unavailable");
  });

  it("returns the fallback for an invalid date string", () => {
    expect(formatDateTime("not-a-date")).toBe("Unavailable");
  });

  it("accepts a custom fallback", () => {
    expect(formatDateTime(null, "")).toBe("");
    expect(formatDateTime("bad", "N/A")).toBe("N/A");
  });
});

describe("formatDate", () => {
  it("formats a valid date without a time component", () => {
    const result = formatDate("2026-01-05T15:45:00Z");
    expect(result).not.toBe("Unavailable");
    expect(result).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns the fallback for an invalid input", () => {
    expect(formatDate(null)).toBe("Unavailable");
    expect(formatDate("not-a-date")).toBe("Unavailable");
  });
});
