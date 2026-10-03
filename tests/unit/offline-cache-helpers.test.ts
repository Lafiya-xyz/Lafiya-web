import { describe, expect, it } from "vitest";

import {
  buildOfflineBannerHtml,
  cardSecretFromUrl,
  createOfflineEnvelope,
  decryptOfflineEnvelope,
  encryptOfflineEnvelope,
  formatCachedAt,
  injectOfflineBanner,
  OFFLINE_MAX_AGE_MS,
  offlineCacheKey,
  offlineEnvelopeResponse,
  renderOfflineEnvelope,
  validateOfflineEnvelope,
} from "../../public/offline-cache-helpers.js";

function sourceHtml(overrides: Record<string, unknown> = {}) {
  return `<html><body><script id="lafiya-offline-envelope-source" type="application/json">${JSON.stringify(
    {
      version: 1,
      authorizationKind: "capability",
      offlineAllowed: true,
      authorizationExpiresAt: "2026-09-01T00:00:00.000Z",
      recordUpdatedAt: "2026-08-20T00:00:00.000Z",
      trust: { state: "verified", updatedAt: "2026-08-20T00:00:00.000Z" },
      projection: {
        name: "Synthetic Patient",
        age: 20,
        bloodGroup: "O+",
        genotype: "AS",
        allergies: ["Penicillin"],
        medications: [],
        chronicConditions: [],
        emergencyContacts: [],
        language: "Hausa",
      },
      ...overrides,
    },
  )}</script></body></html>`;
}

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

  describe("versioned emergency envelopes", () => {
    it("stores structured projection metadata, never rendered source HTML", async () => {
      const envelope = await createOfflineEnvelope(
        sourceHtml(),
        "2026-08-21T00:00:00.000Z",
      );
      expect(envelope).toMatchObject({
        version: 1,
        authorizationKind: "capability",
        projection: { name: "Synthetic Patient" },
      });
      expect(JSON.stringify(envelope)).not.toContain("<html>");
      await expect(
        validateOfflineEnvelope(envelope, "2026-08-21T00:00:01.000Z"),
      ).resolves.toEqual({ valid: true, reason: null });
    });

    it("fails closed for tampering, unsupported sources, and expired authorization", async () => {
      const envelope = await createOfflineEnvelope(
        sourceHtml(),
        "2026-08-21T00:00:00.000Z",
      );
      const tampered = {
        ...envelope,
        projection: { ...envelope!.projection, name: "Tampered" },
      };
      await expect(
        validateOfflineEnvelope(tampered, "2026-08-21T00:00:01.000Z"),
      ).resolves.toEqual({ valid: false, reason: "corrupted" });
      await expect(
        createOfflineEnvelope(
          sourceHtml({ version: 99 }),
          "2026-08-21T00:00:00.000Z",
        ),
      ).resolves.toBeNull();
      await expect(
        validateOfflineEnvelope(envelope, "2026-09-02T00:00:00.000Z"),
      ).resolves.toEqual({ valid: false, reason: "expired" });
    });

    it("enforces the documented maximum offline age and renders freshness warnings", async () => {
      const envelope = await createOfflineEnvelope(
        sourceHtml({ authorizationExpiresAt: "2026-12-01T00:00:00.000Z" }),
        "2026-08-21T00:00:00.000Z",
      );
      await expect(
        validateOfflineEnvelope(
          envelope,
          new Date(
            Date.parse("2026-08-21T00:00:00.000Z") + OFFLINE_MAX_AGE_MS + 1,
          ).toISOString(),
        ),
      ).resolves.toEqual({ valid: false, reason: "expired" });
      const html = renderOfflineEnvelope(envelope);
      expect(html).toContain(
        "Current authorization and revocation cannot be checked offline",
      );
      expect(html).toContain("Synthetic Patient");
    });
  });

  describe("encryption at rest (issue #630)", () => {
    const token = "c1_" + "A".repeat(43);
    const url = `https://lafiya.example/card/c/${token}`;

    async function encryptedBytes() {
      const envelope = await createOfflineEnvelope(
        sourceHtml(),
        "2026-08-21T00:00:00.000Z",
      );
      const cacheKey = await offlineCacheKey(url);
      const record = (await encryptOfflineEnvelope(
        envelope,
        cardSecretFromUrl(url),
        cacheKey,
      ))!;
      const raw = new Uint8Array(
        await offlineEnvelopeResponse(record).arrayBuffer(),
      );
      return { envelope, cacheKey, record, raw };
    }

    it("keeps PHI and the capability out of the raw cached bytes and key", async () => {
      const { cacheKey, raw } = await encryptedBytes();
      const text = new TextDecoder().decode(raw);
      for (const phi of [
        "Synthetic Patient",
        "Penicillin",
        "Hausa",
        "O+",
        "projection",
        token,
      ]) {
        expect(text).not.toContain(phi);
      }
      expect(cacheKey).toMatch(/^\/__lafiya-offline-envelope\/[0-9a-f]{64}$/);
      expect(cacheKey).not.toContain(token);
    });

    it("decrypts back to a valid envelope from the same URL", async () => {
      const { envelope, cacheKey, raw } = await encryptedBytes();
      const stored = JSON.parse(new TextDecoder().decode(raw));
      const decrypted = await decryptOfflineEnvelope(
        stored,
        cardSecretFromUrl(url),
        cacheKey,
      );
      expect(decrypted).toEqual(envelope);
      await expect(
        validateOfflineEnvelope(decrypted, "2026-08-21T00:00:01.000Z"),
      ).resolves.toEqual({ valid: true, reason: null });
    });

    it("refuses a different link, a swapped cache entry, tampering, and v1 plaintext", async () => {
      const { envelope, cacheKey, record } = await encryptedBytes();
      const otherUrl = `https://lafiya.example/card/c/c1_${"B".repeat(43)}`;
      expect(
        await decryptOfflineEnvelope(
          record,
          cardSecretFromUrl(otherUrl),
          cacheKey,
        ),
      ).toBeNull();
      expect(
        await decryptOfflineEnvelope(
          record,
          cardSecretFromUrl(url),
          await offlineCacheKey(otherUrl),
        ),
      ).toBeNull();
      const tampered = {
        ...record,
        ciphertext: record.ciphertext.replace(/^./, (c: string) =>
          c === "A" ? "B" : "A",
        ),
      };
      expect(
        await decryptOfflineEnvelope(
          tampered,
          cardSecretFromUrl(url),
          cacheKey,
        ),
      ).toBeNull();
      expect(
        await decryptOfflineEnvelope(
          envelope,
          cardSecretFromUrl(url),
          cacheKey,
        ),
      ).toBeNull();
    });

    it("uses a fresh salt and IV per envelope", async () => {
      const first = await encryptedBytes();
      const second = await encryptedBytes();
      expect(first.record.salt).not.toBe(second.record.salt);
      expect(first.record.iv).not.toBe(second.record.iv);
    });

    it("only derives secrets from card URLs", () => {
      expect(cardSecretFromUrl(url)).toBe(token);
      expect(cardSecretFromUrl("https://lafiya.example/profile")).toBeNull();
    });
  });
});
