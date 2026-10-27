import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  assertLayout,
  CR80_A4,
  DEFAULT_MIN_MODULE_MM,
  paginateCardSheets,
  qrModuleSizeMm,
  STICKER_A4,
} from "./batchCardSheet";

// Version 3 QR (29 modules) fits a typical card URL at ECC Q.
const QR_MODULES = 29;
const ids = (n: number) => Array.from({ length: n }, (_, i) => `card-${i}`);

describe("batch card sheets (issue #767)", () => {
  it("keeps printed QR module size at or above the configured minimum", () => {
    for (const layout of [CR80_A4, STICKER_A4]) {
      expect(qrModuleSizeMm(layout, QR_MODULES)).toBeGreaterThanOrEqual(
        DEFAULT_MIN_MODULE_MM,
      );
    }
    expect(() =>
      assertLayout({ ...CR80_A4, qrSizeMm: 10 }, QR_MODULES),
    ).toThrow("QR_MODULE_TOO_SMALL");
  });

  it("generates a 500-card batch within the time budget", () => {
    const start = performance.now();
    let pages = 0;
    let cards = 0;
    for (const page of paginateCardSheets(ids(500), CR80_A4, QR_MODULES)) {
      pages++;
      cards += page.items.length;
    }
    expect(cards).toBe(500);
    expect(pages).toBe(50);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("produces deterministic output (golden hash)", () => {
    const hash = () =>
      createHash("sha256")
        .update(
          JSON.stringify([
            ...paginateCardSheets(ids(23), STICKER_A4, QR_MODULES),
          ]),
        )
        .digest("hex");
    expect(hash()).toBe(hash());
    const [first] = paginateCardSheets(ids(1), CR80_A4, QR_MODULES);
    expect(first.items[0]).toEqual({
      id: "card-0",
      xMm: 16.4,
      yMm: 1.55,
      qrXMm: 43.2,
      qrYMm: 12.54,
    });
    expect(first.cropMarks).toHaveLength(8);
  });
});
