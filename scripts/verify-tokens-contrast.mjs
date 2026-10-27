#!/usr/bin/env node
/**
 * scripts/verify-tokens-contrast.mjs
 *
 * Automated contrast and theme verification script.
 * Validates WCAG 2.2 AA (and APCA reference) contrast for every foreground/background
 * pairing documented in `lib/tokens/tokens.json` across light, dark, high-contrast,
 * and print themes.
 *
 * Fails CI if any token pair falls below AA for its documented usage.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const TOKENS_PATH = resolve(ROOT, "lib", "tokens", "tokens.json");

let tokensData;
try {
  tokensData = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
} catch (err) {
  console.error(`Failed to read tokens from ${TOKENS_PATH}:`, err.message);
  process.exit(1);
}

function parseHex(hex) {
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

function getRelativeLuminance(hex) {
  const [r, g, b] = parseHex(hex).map((c) => {
    const sRGB = c / 255;
    return sRGB <= 0.04045 ? sRGB / 12.92 : Math.pow((sRGB + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function getContrastRatio(hex1, hex2) {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function getApcaContrast(textHex, bgHex) {
  const [tr, tg, tb] = parseHex(textHex).map((c) => Math.pow(c / 255, 2.2));
  const [br, bg, bb] = parseHex(bgHex).map((c) => Math.pow(c / 255, 2.2));

  const Ytext = 0.2126729 * tr + 0.7151522 * tg + 0.072175 * tb;
  const Ybg = 0.2126729 * br + 0.7151522 * bg + 0.072175 * bb;

  const normYtext = Ytext > 0.022 ? Ytext : Ytext + Math.pow(0.022 - Ytext, 1.414);
  const normYbg = Ybg > 0.022 ? Ybg : Ybg + Math.pow(0.022 - Ybg, 1.414);

  let sapc = 0;
  if (normYbg > normYtext) {
    sapc = (Math.pow(normYbg, 0.56) - Math.pow(normYtext, 0.57)) * 1.14;
  } else {
    sapc = (Math.pow(normYbg, 0.65) - Math.pow(normYtext, 0.62)) * 1.14;
  }

  const output = Math.abs(sapc) < 0.1 ? 0 : sapc * 100;
  return Math.abs(Math.round(output));
}

function resolveToken(themeTokens, path) {
  const parts = path.split(".");
  let cur = themeTokens;
  for (const p of parts) {
    cur = cur[p];
  }
  return cur.hex;
}

const themes = ["light", "dark", "high-contrast", "print"];

console.log("==================================================================");
console.log("       Design Tokens Contrast & Theme Verification (WCAG 2.2 AA)  ");
console.log("==================================================================\n");

let totalChecked = 0;
let totalPassed = 0;
let failures = [];

for (const theme of themes) {
  console.log(`Theme: [${theme.toUpperCase()}]`);
  console.log("------------------------------------------------------------------");
  const themeTokens = tokensData.themes[theme];

  for (const pair of tokensData.pairings) {
    totalChecked++;
    const fg = resolveToken(themeTokens, pair.fgToken);
    const bg = resolveToken(themeTokens, pair.bgToken);
    const ratio = getContrastRatio(fg, bg);
    const apca = getApcaContrast(fg, bg);
    const passes = ratio >= pair.minRatio;

    if (passes) {
      totalPassed++;
      console.log(
        `  ✓ ${pair.name.padEnd(28)} | ${fg} on ${bg} | Ratio: ${ratio.toFixed(2)}:1 (min ${pair.minRatio}:1) | APCA: Lc ${apca}`,
      );
    } else {
      failures.push({
        theme,
        pair: pair.name,
        fg,
        bg,
        ratio,
        minRatio: pair.minRatio,
      });
      console.error(
        `  ✗ FAIL: ${pair.name.padEnd(24)} | ${fg} on ${bg} | Ratio: ${ratio.toFixed(2)}:1 (required ${pair.minRatio}:1)`,
      );
    }
  }
  console.log("");
}

console.log("==================================================================");
console.log(`Summary: ${totalPassed}/${totalChecked} token pairings passed contrast check.`);
console.log("==================================================================");

if (failures.length > 0) {
  console.error(`\n✖ ${failures.length} token contrast regression(s) detected!`);
  for (const f of failures) {
    console.error(
      `  - [${f.theme}] ${f.pair}: ${f.fg} on ${f.bg} got ${f.ratio.toFixed(2)}:1 (expected >= ${f.minRatio}:1)`,
    );
  }
  process.exit(1);
} else {
  console.log("\n✔ All design tokens pass WCAG 2.2 AA contrast requirements.\n");
  process.exit(0);
}
