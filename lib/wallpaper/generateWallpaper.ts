/**
 * @module generateWallpaper
 *
 * Renders a phone lock-screen wallpaper (server-side, via `sharp`) that
 * shows the patient's emergency QR code and, only for fields the patient
 * has explicitly opted in to for THIS wallpaper, a short critical-facts
 * summary (e.g. "Blood group O- | Allergic to penicillin").
 *
 * ## Privacy model
 * This is a *separate*, stricter opt-in from the public card's
 * `disclosure_policy` (see lib/supabase/types.ts). The wallpaper is visible
 * to anyone who picks up the phone, without unlocking it or scanning
 * anything -- so it defaults to QR-only, and every field shown on the image
 * itself must be individually selected by the caller for that generation.
 * Nothing is persisted: the selection lives only in the request.
 *
 * ## Layout
 * - High-contrast (near-black background, white/light text) so the code
 *   and text stay legible over a phone's lock-screen clock/notification
 *   chrome and in outdoor light.
 * - A top and bottom safe area is left clear of content so the OS clock,
 *   date, and notification shade don't overlap the QR code or text.
 * - The QR code is sized relative to the canvas so it still decodes at
 *   ~30cm under a phone camera at both supported resolutions.
 */
import sharp from "sharp";

import { generateQrBuffer } from "@/lib/qr/generateQrDataUrl";

export const WALLPAPER_RESOLUTIONS = {
  "1080x2400": { width: 1080, height: 2400 },
  "720x1600": { width: 720, height: 1600 },
} as const;

export type WallpaperResolution = keyof typeof WALLPAPER_RESOLUTIONS;

/** Ordered, allow-listed set of facts a patient may opt in to showing. */
export const WALLPAPER_FIELDS = [
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
] as const;

export type WallpaperField = (typeof WALLPAPER_FIELDS)[number];

const FIELD_LABELS: Record<WallpaperField, string> = {
  blood_group: "Blood group",
  genotype: "Genotype",
  allergies: "Allergies",
  medications: "Medications",
  chronic_conditions: "Chronic conditions",
};

/** Background/foreground pair chosen for a high-contrast lock screen. */
const BACKGROUND = "#0a0a0a";
const FOREGROUND = "#f5f5f5";
const ACCENT = "#f5f5f5";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Wraps `text` onto lines no wider than roughly `maxChars` characters, for
 * rendering inside the fixed-width SVG text block below. This is a coarse
 * character-count wrap (not real text-metric measurement, which `sharp`/
 * `libvips` doesn't expose) -- generous enough for the short fact strings
 * this renders while never overflowing the safe area's fixed width.
 */
function wrapLine(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export type WallpaperFieldValues = Partial<Record<WallpaperField, string>>;

/**
 * Renders the wallpaper PNG.
 *
 * @param cardUrl The public emergency card URL to encode as a QR code.
 * @param resolution One of the supported lock-screen resolutions.
 * @param selectedFields Fields the patient opted in to display on the
 *   wallpaper itself. Any field without a non-empty value in
 *   `fieldValues` is silently skipped, even if selected.
 * @param fieldValues The patient's current values for each allow-listed
 *   field, already resolved by the caller (this function does not read
 *   the database or accept arbitrary caller-supplied text for these,
 *   so it can't be used to stamp unrelated text onto the image).
 */
export async function generateWallpaper({
  cardUrl,
  resolution,
  selectedFields,
  fieldValues,
}: {
  cardUrl: string;
  resolution: WallpaperResolution;
  selectedFields: WallpaperField[];
  fieldValues: WallpaperFieldValues;
}): Promise<Buffer> {
  const { width, height } = WALLPAPER_RESOLUTIONS[resolution];

  // Reserve a top safe area (clock/date/notifications) and bottom safe
  // area (lock-screen shortcuts/nav gesture bar), proportional to canvas
  // height so both supported resolutions keep the same relative margins.
  const topSafeArea = Math.round(height * 0.22);
  const bottomSafeArea = Math.round(height * 0.14);
  const contentHeight = height - topSafeArea - bottomSafeArea;

  // Size the QR code relative to the shorter canvas dimension so it stays
  // comfortably scannable at ~30cm on both supported resolutions, per the
  // same error-correction/quiet-zone rationale as the on-screen QR (see
  // lib/qr/generateQrDataUrl.ts).
  const qrSize = Math.min(Math.round(width * 0.62), Math.round(contentHeight * 0.55));
  const qrBuffer = await generateQrBuffer(cardUrl, qrSize);

  // White quiet-zone card behind the QR code so it stays scannable against
  // the dark, high-contrast background (a QR code needs a light quiet
  // zone; the library's own margin option is white-on-white otherwise).
  const qrPadding = Math.round(qrSize * 0.08);
  const qrCardSize = qrSize + qrPadding * 2;
  const qrCardBuffer = await sharp({
    create: {
      width: qrCardSize,
      height: qrCardSize,
      channels: 4,
      background: "#ffffff",
    },
  })
    .png()
    .toBuffer();

  const facts = selectedFields
    .map((field) => {
      const value = fieldValues[field];
      if (!value || value.trim().length === 0) return null;
      return `${FIELD_LABELS[field]}: ${value}`;
    })
    .filter((line): line is string => line !== null);

  const labelFontSize = Math.round(width * 0.045);
  const factFontSize = Math.round(width * 0.036);
  const lineHeight = Math.round(factFontSize * 1.5);
  const maxChars = Math.round(width / (factFontSize * 0.58));

  const wrappedFacts = facts.flatMap((line) => wrapLine(line, maxChars));

  const qrCardY = topSafeArea + Math.round((contentHeight * 0.55 - qrCardSize) / 2);
  const qrCardX = Math.round((width - qrCardSize) / 2);
  const labelY = qrCardY + qrCardSize + labelFontSize + Math.round(height * 0.03);
  const factsStartY = labelY + Math.round(height * 0.035);

  const factLines = wrappedFacts
    .map(
      (line, index) =>
        `<text x="${width / 2}" y="${factsStartY + index * lineHeight}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="${factFontSize}" fill="${FOREGROUND}" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join("\n");

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="${BACKGROUND}" />
    <text x="${width / 2}" y="${labelY}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="${labelFontSize}" font-weight="600" fill="${ACCENT}" text-anchor="middle" letter-spacing="1">MEDICAL ID — SCAN ME</text>
    ${factLines}
  </svg>`;

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: BACKGROUND,
    },
  })
    .composite([
      { input: Buffer.from(svg), top: 0, left: 0 },
      { input: qrCardBuffer, top: qrCardY, left: qrCardX },
      {
        input: qrBuffer,
        top: qrCardY + qrPadding,
        left: qrCardX + qrPadding,
      },
    ])
    .png()
    .toBuffer();
}
