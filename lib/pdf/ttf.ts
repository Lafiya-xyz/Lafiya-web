import "server-only";

/**
 * Minimal TrueType reader: just enough metrics to embed a simple
 * (WinAnsi) TrueType font in a PDF with correct /Widths (issue #773).
 */
export interface TtfMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  /** Advance width in PDF glyph-space units (1/1000 em) for char codes 0–255. */
  widths: number[];
}

export function readTtfMetrics(font: Buffer): TtfMetrics {
  const numTables = font.readUInt16BE(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(
      font.toString("latin1", rec, rec + 4),
      font.readUInt32BE(rec + 8),
    );
  }
  const at = (tag: string) => {
    const off = tables.get(tag);
    if (off === undefined) throw new Error(`TTF_MISSING_${tag}`);
    return off;
  };

  const head = at("head");
  const unitsPerEm = font.readUInt16BE(head + 18);
  const scale = (v: number) => Math.round((v * 1000) / unitsPerEm);
  const bbox: TtfMetrics["bbox"] = [
    scale(font.readInt16BE(head + 36)),
    scale(font.readInt16BE(head + 38)),
    scale(font.readInt16BE(head + 40)),
    scale(font.readInt16BE(head + 42)),
  ];

  const hhea = at("hhea");
  const ascent = scale(font.readInt16BE(hhea + 4));
  const descent = scale(font.readInt16BE(hhea + 6));
  const numHMetrics = font.readUInt16BE(hhea + 34);

  const os2 = tables.get("OS/2");
  const capHeight =
    os2 !== undefined && font.readUInt16BE(os2) >= 2
      ? scale(font.readInt16BE(os2 + 88))
      : Math.round(ascent * 0.7);

  const hmtx = at("hmtx");
  const advance = (gid: number) =>
    font.readUInt16BE(hmtx + Math.min(gid, numHMetrics - 1) * 4);

  // cmap: Windows Unicode BMP (3,1), format 4.
  const cmap = at("cmap");
  let sub = -1;
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
    const rec = cmap + 4 + i * 8;
    if (font.readUInt16BE(rec) === 3 && font.readUInt16BE(rec + 2) === 1) {
      sub = cmap + font.readUInt32BE(rec + 4);
    }
  }
  if (sub < 0 || font.readUInt16BE(sub) !== 4) throw new Error("TTF_NO_CMAP4");
  const segX2 = font.readUInt16BE(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  const glyphFor = (code: number): number => {
    for (let s = 0; s < segX2; s += 2) {
      if (code > font.readUInt16BE(ends + s)) continue;
      const start = font.readUInt16BE(starts + s);
      if (code < start) return 0;
      const delta = font.readInt16BE(deltas + s);
      const range = font.readUInt16BE(ranges + s);
      if (range === 0) return (code + delta) & 0xffff;
      const g = font.readUInt16BE(ranges + s + range + (code - start) * 2);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  const widths: number[] = [];
  for (let code = 0; code < 256; code++)
    widths.push(scale(advance(glyphFor(code))));
  return { unitsPerEm, ascent, descent, capHeight, bbox, widths };
}
