import { describe, expect, it } from "vitest";

import { sanitizeNext } from "./page";

describe("sanitizeNext (#522)", () => {
  it("passes through a plain in-app relative path", () => {
    expect(sanitizeNext("/profile/export")).toBe("/profile/export");
  });

  it("defaults to /profile when next is missing", () => {
    expect(sanitizeNext(undefined)).toBe("/profile");
  });

  it("rejects a protocol-relative URL (open-redirect via //host)", () => {
    expect(sanitizeNext("//evil.example.com/phish")).toBe("/profile");
  });

  it("rejects an absolute URL to another host", () => {
    expect(sanitizeNext("https://evil.example.com")).toBe("/profile");
  });

  it("rejects a path with no leading slash", () => {
    expect(sanitizeNext("profile/export")).toBe("/profile");
  });
});
