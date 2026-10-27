/**
 * @file Color Contrast Calculation Utilities
 *
 * Implements:
 * 1. WCAG 2.2 Relative Luminance and Contrast Ratio (ISO 9241-306 / WCAG 2.2 AA)
 * 2. APCA (Accessible Perceptual Contrast Algorithm) reference Lightness contrast (Lc)
 */

export function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, "");
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  if (clean.length === 6) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  throw new Error(`Invalid hex color: ${hex}`);
}

/**
 * Returns WCAG 2.2 relative luminance for a given hex color.
 */
export function getRelativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const sRGB = c / 255;
    return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Computes WCAG 2.2 contrast ratio between two hex colors.
 * Returns a value between 1.0 and 21.0.
 */
export function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Reference APCA (Accessible Perceptual Contrast Algorithm) lightness contrast (Lc).
 *
 * Note: APCA is polar (positive when text is darker than bg, negative when text is lighter than bg).
 * Returns absolute Lc contrast value.
 */
export function getApcaContrast(textHex: string, bgHex: string): number {
  const [tr, tg, tb] = parseHex(textHex).map((c) => Math.pow(c / 255, 2.2));
  const [br, bg, bb] = parseHex(bgHex).map((c) => Math.pow(c / 255, 2.2));

  // Y perceptual luminance
  const Ytext = 0.2126729 * tr + 0.7151522 * tg + 0.072175 * tb;
  const Ybg = 0.2126729 * br + 0.7151522 * bg + 0.072175 * bb;

  // Soft clamp for black level
  const normYtext = Ytext > 0.022 ? Ytext : Ytext + Math.pow(0.022 - Ytext, 1.414);
  const normYbg = Ybg > 0.022 ? Ybg : Ybg + Math.pow(0.022 - Ybg, 1.414);

  // APCA simple power law approximation
  let sapc = 0;
  if (normYbg > normYtext) {
    // Dark text on light background
    sapc = (Math.pow(normYbg, 0.56) - Math.pow(normYtext, 0.57)) * 1.14;
  } else {
    // Light text on dark background
    sapc = (Math.pow(normYbg, 0.65) - Math.pow(normYtext, 0.62)) * 1.14;
  }

  const output = Math.abs(sapc) < 0.1 ? 0 : sapc * 100;
  return Math.abs(Math.round(output));
}
