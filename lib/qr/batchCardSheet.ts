/**
 * Print-ready batch card sheet layout (issue #767).
 *
 * Pure, deterministic layout math for CR80 card and sticker sheets with crop
 * marks and bleed. Pages are yielded lazily so large batches stay within a
 * bounded memory footprint; the renderer consumes one page at a time.
 */

export type SheetLayout = {
  name: string;
  pageWidthMm: number;
  pageHeightMm: number;
  itemWidthMm: number;
  itemHeightMm: number;
  columns: number;
  rows: number;
  gutterMm: number;
  bleedMm: number;
  qrSizeMm: number;
};

/** A4 sheet of CR80 (ISO/IEC 7810 ID-1) cards, 2 × 5. */
export const CR80_A4: SheetLayout = {
  name: "cr80-a4",
  pageWidthMm: 210,
  pageHeightMm: 297,
  itemWidthMm: 85.6,
  itemHeightMm: 53.98,
  columns: 2,
  rows: 5,
  gutterMm: 6,
  bleedMm: 2,
  qrSizeMm: 32,
};

/** A4 sheet of 50 mm square stickers, 3 × 5. */
export const STICKER_A4: SheetLayout = {
  name: "sticker-a4",
  pageWidthMm: 210,
  pageHeightMm: 297,
  itemWidthMm: 50,
  itemHeightMm: 50,
  columns: 3,
  rows: 5,
  gutterMm: 8,
  bleedMm: 1,
  qrSizeMm: 32,
};

/** Default minimum printed module size for reliable phone scanning. */
export const DEFAULT_MIN_MODULE_MM = 0.5;

export type PlacedItem = {
  id: string;
  xMm: number;
  yMm: number;
  qrXMm: number;
  qrYMm: number;
  /** Truncated human-verifiable check code printed near the QR (issue #974). */
  checkCode?: string;
  /** ISO date (YYYY-MM-DD) the card was printed; aids tamper detection. */
  printDate?: string;
};

export type SheetPage = {
  index: number;
  items: PlacedItem[];
  cropMarks: Array<[number, number, number, number]>;
};

/** Optional per-card metadata carried through batch layout (issue #974). */
export type CardMeta = {
  checkCode?: string;
  printDate?: string;
};

/** Placement of the check code / print date text block within one item. */
export type CheckCodePlacement = {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Font size in mm; kept small but above the legibility floor. */
  fontSizeMm: number;
};

/** Minimum legible printed height for the check code text. */
export const MIN_CHECK_CODE_FONT_MM = 1.8;
/** Minimum gap between the QR quiet zone and the check-code text block. */
export const MIN_CHECK_CODE_GAP_MM = 1;
/** Reserved height for the print-date line beneath the check code. */
export const PRINT_DATE_LINE_MM = 2.5;
=======

const round = (n: number) => Math.round(n * 100) / 100;

/** Printed size of one QR module; includes the 4-module quiet zone. */
export function qrModuleSizeMm(layout: SheetLayout, qrModules: number): number {
  return layout.qrSizeMm / (qrModules + 8);
}

export function assertLayout(
  layout: SheetLayout,
  qrModules: number,
  minModuleMm = DEFAULT_MIN_MODULE_MM,
): void {
  if (qrModuleSizeMm(layout, qrModules) < minModuleMm)
    throw new Error("QR_MODULE_TOO_SMALL");
  if (layout.qrSizeMm > Math.min(layout.itemWidthMm, layout.itemHeightMm))
    throw new Error("QR_EXCEEDS_ITEM");
  const usedW =
    layout.columns * layout.itemWidthMm +
    (layout.columns - 1) * layout.gutterMm;
  const usedH =
    layout.rows * layout.itemHeightMm + (layout.rows - 1) * layout.gutterMm;
  if (usedW > layout.pageWidthMm || usedH > layout.pageHeightMm)
    throw new Error("LAYOUT_EXCEEDS_PAGE");
  // The check-code block must fit beside the QR without overlapping it.
  checkCodePlacement(layout);
}

/**
 * Deterministic placement of the check-code / print-date text block for one
 * item. The block sits to the right of the QR (including its quiet zone) and
 * is vertically centred on the QR. Throws if it cannot fit inside the item.
 */
export function checkCodePlacement(layout: SheetLayout): CheckCodePlacement {
  const quietZoneMm = (layout.qrSizeMm / (layout.qrSizeMm + 8)) * 8;
  const qrRightMm = (layout.itemWidthMm + layout.qrSizeMm) / 2;
  const xMm = qrRightMm + quietZoneMm + MIN_CHECK_CODE_GAP_MM;
  const widthMm = layout.itemWidthMm - xMm;
  const heightMm = MIN_CHECK_CODE_FONT_MM + PRINT_DATE_LINE_MM;
  if (widthMm <= 0) throw new Error("CHECK_CODE_NO_ROOM");
  if (heightMm > layout.itemHeightMm) throw new Error("CHECK_CODE_TOO_TALL");
  const yMm = (layout.itemHeightMm - heightMm) / 2;
  if (yMm < 0) throw new Error("CHECK_CODE_TOO_TALL");
  return {
    xMm: round(xMm),
    yMm: round(yMm),
    widthMm: round(widthMm),
    heightMm: round(heightMm),
    fontSizeMm: MIN_CHECK_CODE_FONT_MM,
  };
}

export function* paginateCardSheets(
  ids: Iterable<string>,
  layout: SheetLayout,
  qrModules: number,
  minModuleMm = DEFAULT_MIN_MODULE_MM,
  meta?: Iterable<CardMeta> | Map<string, CardMeta>,
): Generator<SheetPage> {
  assertLayout(layout, qrModules, minModuleMm);
  const perPage = layout.columns * layout.rows;
  const usedW =
    layout.columns * layout.itemWidthMm +
    (layout.columns - 1) * layout.gutterMm;
  const usedH =
    layout.rows * layout.itemHeightMm + (layout.rows - 1) * layout.gutterMm;
  const marginX = (layout.pageWidthMm - usedW) / 2;
  const marginY = (layout.pageHeightMm - usedH) / 2;
  const markLen = Math.min(layout.gutterMm / 2, 4);

  let page: PlacedItem[] = [];
  let index = 0;
  const build = (): SheetPage => {
    const cropMarks: SheetPage["cropMarks"] = [];
    for (const item of page) {
      const x2 = item.xMm + layout.itemWidthMm;
      const y2 = item.yMm + layout.itemHeightMm;
      for (const [x, y] of [
        [item.xMm, item.yMm],
        [x2, item.yMm],
        [item.xMm, y2],
        [x2, y2],
      ]) {
        const dx = x === item.xMm ? -1 : 1;
        const dy = y === item.yMm ? -1 : 1;
        const off = layout.bleedMm;
        cropMarks.push([
          round(x + dx * off),
          y,
          round(x + dx * (off + markLen)),
          y,
        ]);
        cropMarks.push([
          x,
          round(y + dy * off),
          x,
          round(y + dy * (off + markLen)),
        ]);
      }
    }
    return { index: index++, items: page, cropMarks };
  };

  const metaIter = meta
    ? meta instanceof Map
      ? meta.values()
      : meta[Symbol.iterator]()
    : undefined;

  for (const id of ids) {
    const slot = page.length;
    const col = slot % layout.columns;
    const row = Math.floor(slot / layout.columns);
    const xMm = round(marginX + col * (layout.itemWidthMm + layout.gutterMm));
    const yMm = round(marginY + row * (layout.itemHeightMm + layout.gutterMm));
    const m = metaIter ? metaIter.next() : undefined;
    const cardMeta: CardMeta =
      m && !m.done ? (m.value as CardMeta) : {};
    page.push({
      id,
      xMm,
      yMm,
      qrXMm: round(xMm + (layout.itemWidthMm - layout.qrSizeMm) / 2),
      qrYMm: round(yMm + (layout.itemHeightMm - layout.qrSizeMm) / 2),
      ...(cardMeta.checkCode !== undefined
        ? { checkCode: cardMeta.checkCode }
        : {}),
      ...(cardMeta.printDate !== undefined
        ? { printDate: cardMeta.printDate }
        : {}),
    });
    if (page.length === perPage) {
      yield build();
      page = [];
    }
  }
  if (page.length > 0) yield build();
}

/** Only aggregate counts are safe to log for a batch run. */
export function batchLogSummary(pages: number, cards: number) {
  return { event: "card_sheet_batch", pages, cards };
}
