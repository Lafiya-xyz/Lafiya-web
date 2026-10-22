import "server-only";

import { readFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import QRCode from "qrcode";

import { readTtfMetrics, type TtfMetrics } from "./ttf";

/**
 * Server-side, tagged (PDF/UA-1) emergency card PDF — issue #773.
 *
 * Every visible string is wrapped in a marked-content sequence tied to a
 * structure element; decorations are Artifacts. The structure tree order is
 * the reading order and matches the layout order, which puts the most
 * clinically critical fields first. Only the fields shown on the printed card
 * are written: metadata carries a generic title, never the patient's name.
 *
 * Validated by `checkPdfUa` (lib/pdf/pdfua-check.ts) in tests.
 */

export const CARD_PDF_TITLE = "Lafiya emergency card";
/** Low-bandwidth download budget (the embedded font is ~125 KB of it). */
export const CARD_PDF_MAX_BYTES = 200 * 1024;

export interface PrintableCard {
  name: string | null;
  age: number | null;
  blood_group: string | null;
  genotype: string | null;
  allergies: string[] | null;
  medications: string[] | null;
  chronic_conditions: string[] | null;
  emergency_contacts: Array<{
    name: string;
    phone: string;
    relationship: string;
  }> | null;
  language: string | null;
}

let fontCache: { bytes: Buffer; metrics: TtfMetrics } | null = null;
function font() {
  if (!fontCache) {
    const bytes = readFileSync(
      path.join(process.cwd(), "lib/pdf/fonts/Geist-Regular.ttf"),
    );
    fontCache = { bytes, metrics: readTtfMetrics(bytes) };
  }
  return fontCache;
}

/** Maps to WinAnsi-safe Latin-1, stripping diacritics the font encoding cannot carry. */
function toWinAnsi(text: string): string {
  return [...text.normalize("NFC")]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255)) return ch;
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return base.length === 1 && base.charCodeAt(0) < 127 ? base : "?";
    })
    .join("");
}

function pdfString(text: string): string {
  return `(${text.replace(/[\\()]/g, (m) => `\\${m}`)})`;
}

function textWidth(text: string, size: number, widths: number[]): number {
  let w = 0;
  for (const ch of text) w += widths[ch.charCodeAt(0)] ?? 0;
  return (w * size) / 1000;
}

function wrap(
  text: string,
  size: number,
  maxWidth: number,
  widths: number[],
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size, widths) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  // Hard-break overlong tokens such as URLs.
  return lines.flatMap((l) => {
    if (textWidth(l, size, widths) <= maxWidth) return [l];
    const parts: string[] = [];
    let cur = "";
    for (const ch of l) {
      if (cur && textWidth(cur + ch, size, widths) > maxWidth) {
        parts.push(cur);
        cur = "";
      }
      cur += ch;
    }
    return cur ? [...parts, cur] : parts;
  });
}

const list = (v: string[] | null) =>
  v && v.length > 0 ? v.join(", ") : "None recorded";

type Block =
  | { tag: "H1" | "H2" | "P"; text: string; size: number; gray?: boolean }
  | { tag: "Figure"; alt: string; url: string };

/** Reading order == visual order: identity, then the most critical fields. */
export function cardBlocks(card: PrintableCard, cardUrl: string): Block[] {
  const blocks: Block[] = [
    { tag: "H1", text: "Emergency Card", size: 20 },
    {
      tag: "P",
      text: `${card.name ?? "Name withheld"}${card.age !== null ? ` - ${card.age} years old` : ""}`,
      size: 12,
      gray: true,
    },
  ];
  const field = (label: string, value: string) =>
    blocks.push(
      { tag: "H2", text: label, size: 10, gray: true },
      { tag: "P", text: value, size: 13 },
    );
  field("Allergies", list(card.allergies));
  field("Current medications", list(card.medications));
  field("Chronic conditions / implants", list(card.chronic_conditions));
  field("Blood group", card.blood_group ?? "Withheld");
  field("Genotype", card.genotype ?? "Withheld");
  if (card.emergency_contacts && card.emergency_contacts.length > 0) {
    blocks.push({
      tag: "H2",
      text: "Emergency contacts",
      size: 10,
      gray: true,
    });
    for (const c of card.emergency_contacts) {
      blocks.push({
        tag: "P",
        text: `${c.name} (${c.relationship}): ${c.phone}`,
        size: 12,
      });
    }
  }
  field("Language spoken", card.language ?? "Not specified");
  blocks.push(
    {
      tag: "Figure",
      alt: `QR code that opens this emergency card at ${cardUrl}`,
      url: cardUrl,
    },
    { tag: "P", text: cardUrl, size: 8, gray: true },
    {
      tag: "P",
      text: "Not a medical device. Not a substitute for professional medical judgment.",
      size: 8,
      gray: true,
    },
  );
  return blocks;
}

function pinBlocks(cardPin: string): Block[] {
  return [
    { tag: "H2", text: "Card PIN (back of card)", size: 10, gray: true },
    { tag: "P", text: cardPin, size: 28 },
    {
      tag: "P",
      text: "Print on the back or under a scratch panel, away from the QR code. Responders enter it to see protected details.",
      size: 9,
      gray: true,
    },
  ];
}

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 56;
const QR_SIZE = 160;

interface LaidOutPage {
  content: string;
  elems: { tag: string; alt?: string; mcid: number }[];
}

function layoutPage(blocks: Block[], m: TtfMetrics): LaidOutPage {
  const ops: string[] = [];
  const elems: LaidOutPage["elems"] = [];
  let y = PAGE_H - MARGIN;
  const maxW = PAGE_W - 2 * MARGIN;

  for (const b of blocks) {
    const mcid = elems.length;
    if (b.tag === "Figure") {
      y -= 8;
      const qr = QRCode.create(b.url, { errorCorrectionLevel: "Q" });
      const n = qr.modules.size;
      const cell = QR_SIZE / n;
      const x0 = (PAGE_W - QR_SIZE) / 2;
      const top = y;
      const rects: string[] = [];
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.modules.get(r, c)) {
            rects.push(
              `${(x0 + c * cell).toFixed(2)} ${(top - (r + 1) * cell).toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re`,
            );
          }
        }
      }
      ops.push(`/Figure <</MCID ${mcid}>> BDC 0 g ${rects.join(" ")} f EMC`);
      elems.push({ tag: "Figure", alt: b.alt, mcid });
      y -= QR_SIZE + 8;
      continue;
    }
    const text = toWinAnsi(b.text);
    const lines = wrap(text, b.size, maxW, m.widths);
    const leading = b.size * 1.3;
    if (b.tag === "H2") y -= 6;
    const shown = lines
      .map((line, i) => {
        y -= leading;
        return `${i === 0 ? `${MARGIN} ${y.toFixed(2)} Td` : `0 ${(-leading).toFixed(2)} Td`} ${pdfString(line)} Tj`;
      })
      .join(" ");
    const color = b.gray ? "0.35 g" : "0 g";
    ops.push(
      `/${b.tag} <</MCID ${mcid}>> BDC BT /F1 ${b.size} Tf ${color} ${shown} ET EMC`,
    );
    elems.push({ tag: b.tag, mcid });
  }
  // Decorative rule under the heading block is an artifact, not content.
  ops.push(
    `/Artifact BMC 0.85 G 0.5 w ${MARGIN} ${MARGIN - 16} m ${PAGE_W - MARGIN} ${MARGIN - 16} l S EMC`,
  );
  return { content: ops.join("\n"), elems };
}

function xmp(title: string): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
<dc:language><rdf:Bag><rdf:li>en</rdf:li></rdf:Bag></dc:language>
<pdf:Producer>Lafiya</pdf:Producer>
<pdfuaid:part>1</pdfuaid:part>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export function buildCardPdf(
  card: PrintableCard,
  cardUrl: string,
  cardPin?: string,
): Buffer {
  const { bytes: fontBytes, metrics: m } = font();
  const pages = [layoutPage(cardBlocks(card, cardUrl), m)];
  if (cardPin) pages.push(layoutPage(pinBlocks(cardPin), m));

  const objs: (string | Buffer)[] = [];
  const reserve = () => objs.push("");
  const set = (id: number, body: string | Buffer) => {
    objs[id - 1] = body;
  };
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"),
      data,
      Buffer.from("\nendstream", "latin1"),
    ]);

  const catalogId = reserve();
  const pagesId = reserve();
  const structRootId = reserve();
  const documentId = reserve();
  const parentTreeId = reserve();
  const fontId = reserve();
  const descriptorId = reserve();
  const fontFileId = reserve();
  const metadataId = reserve();
  const infoId = reserve();

  const pageIds: number[] = [];
  const elemIds: number[] = [];
  const parentArrays: string[] = [];
  pages.forEach((page, pi) => {
    const pageId = reserve();
    const contentId = reserve();
    pageIds.push(pageId);
    const ids = page.elems.map((e) => {
      const id = reserve();
      const alt = e.alt ? ` /Alt ${pdfString(toWinAnsi(e.alt))}` : "";
      set(
        id,
        `<< /Type /StructElem /S /${e.tag} /P ${documentId} 0 R /Pg ${pageId} 0 R /K ${e.mcid}${alt} >>`,
      );
      return id;
    });
    elemIds.push(...ids);
    parentArrays.push(`${pi} [${ids.map((id) => `${id} 0 R`).join(" ")}]`);
    set(
      contentId,
      stream(
        "/Filter /FlateDecode",
        deflateSync(Buffer.from(page.content, "latin1")),
      ),
    );
    set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> /StructParents ${pi} /Tabs /S >>`,
    );
  });

  set(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R /StructTreeRoot ${structRootId} 0 R /MarkInfo << /Marked true >> /Lang (en) /Metadata ${metadataId} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`,
  );
  set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );
  set(
    structRootId,
    `<< /Type /StructTreeRoot /K ${documentId} 0 R /ParentTree ${parentTreeId} 0 R /ParentTreeNextKey ${pages.length} >>`,
  );
  set(
    documentId,
    `<< /Type /StructElem /S /Document /P ${structRootId} 0 R /K [${elemIds.map((id) => `${id} 0 R`).join(" ")}] >>`,
  );
  set(parentTreeId, `<< /Nums [${parentArrays.join(" ")}] >>`);
  set(
    fontId,
    `<< /Type /Font /Subtype /TrueType /BaseFont /Geist-Regular /FirstChar 32 /LastChar 255 /Widths [${m.widths.slice(32).join(" ")}] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptorId} 0 R >>`,
  );
  set(
    descriptorId,
    `<< /Type /FontDescriptor /FontName /Geist-Regular /Flags 32 /FontBBox [${m.bbox.join(" ")}] /ItalicAngle 0 /Ascent ${m.ascent} /Descent ${m.descent} /CapHeight ${m.capHeight} /StemV 80 /FontFile2 ${fontFileId} 0 R >>`,
  );
  set(
    fontFileId,
    stream(
      `/Filter /FlateDecode /Length1 ${fontBytes.length}`,
      deflateSync(fontBytes),
    ),
  );
  set(
    metadataId,
    stream(
      "/Type /Metadata /Subtype /XML",
      Buffer.from(xmp(CARD_PDF_TITLE), "utf8"),
    ),
  );
  set(infoId, `<< /Title ${pdfString(CARD_PDF_TITLE)} /Producer (Lafiya) >>`);

  const chunks: Buffer[] = [
    Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1"),
  ];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
      typeof body === "string" ? Buffer.from(body, "latin1") : body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = [
    "xref",
    `0 ${objs.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>`,
    "startxref",
    String(offset),
    "%%EOF",
  ].join("\n");
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}
