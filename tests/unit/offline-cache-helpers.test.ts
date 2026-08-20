import { describe, expect, it } from "vitest";

import {
  buildOfflineBannerHtml,
  formatCachedAt,
  injectOfflineBanner,
} from "../../public/offline-cache-helpers.js";

describe("offline-cache-helpers", () => {
  describe("formatCachedAt", () => {
    it("formats a valid ISO timestamp into a non-empty human string", () => {
      const out = formatCachedAt("2024-01-02T03:04:05.000Z");
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toBe("an unknown time");
    });

    it("falls back to a safe string for missing or unparseable input", () => {
      expect(formatCachedAt("")).toBe("an unknown time");
      expect(formatCachedAt(null as unknown as string)).toBe("an unknown time");
      expect(formatCachedAt(undefined as unknown as string)).toBe(
        "an unknown time",
      );
      expect(formatCachedAt("not-a-date")).toBe("an unknown time");
    });
  });

  describe("buildOfflineBannerHtml", () => {
    it("includes the 'Showing cached data as of' wording and the time", () => {
      const html = buildOfflineBannerHtml("2024-01-02T03:04:05.000Z");
      expect(html).toContain("Showing cached data as of");
      // The formatted time should appear somewhere in the banner.
      expect(html.length).toBeGreaterThan("Showing cached data as of".length);
    });

    it("is self-contained with inline styles (readable without app CSS)", () => {
      const html = buildOfflineBannerHtml("2024-01-02T03:04:05.000Z");
      expect(html).toContain("style=");
      expect(html).toContain('role="alert"');
    });
  });

  describe("injectOfflineBanner", () => {
    it("inserts the banner as the first child of <body>", () => {
      const html =
        "<!doctype html><html><head></head><body><h1>Card</h1></body></html>";
      const out = injectOfflineBanner(html, "2024-01-02T03:04:05.000Z");

      const bodyIdx = out.indexOf("<body");
      const bannerIdx = out.indexOf('class="lafiya-offline-banner"');
      const cardIdx = out.indexOf("<h1>Card</h1>");

      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(bannerIdx).toBeGreaterThan(bodyIdx);
      expect(cardIdx).toBeGreaterThan(bannerIdx);
      expect(out).toContain("Showing cached data as of");
    });

    it("preserves attributes already present on the <body> tag", () => {
      const html =
        '<html><head></head><body class="foo" data-x="1"><p>x</p></body></html>';
      const out = injectOfflineBanner(html, "2024-01-02T03:04:05.000Z");
      expect(out).toContain('<body class="foo" data-x="1">');
      expect(out).toContain("lafiya-offline-banner");
    });

    it("prepends the banner when the document has no <body> tag", () => {
      const out = injectOfflineBanner("<p>hi</p>", "2024-01-02T03:04:05.000Z");
      expect(
        out.startsWith(buildOfflineBannerHtml("2024-01-02T03:04:05.000Z")),
      ).toBe(true);
    });

    it("returns just the banner for empty input", () => {
      const out = injectOfflineBanner("", "2024-01-02T03:04:05.000Z");
      expect(out).toContain("lafiya-offline-banner");
    });
  });
});
