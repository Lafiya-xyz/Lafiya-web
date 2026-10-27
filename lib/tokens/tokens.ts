/**
 * @file Design Tokens Source of Truth
 *
 * Defines semantic color tokens across all supported themes:
 * - light
 * - dark
 * - high-contrast (Windows High Contrast / forced-colors)
 * - print
 *
 * Every foreground/background pairing documented here is verified against
 * WCAG 2.2 AA (contrast ratio >= 4.5:1 for normal text, >= 3.0:1 for large/UI)
 * and APCA standards via `scripts/verify-tokens-contrast.mjs`.
 */

import tokensData from "./tokens.json";

export interface ColorTokenValue {
  hex: string;
  description: string;
}

export interface ThemeTokens {
  surface: {
    background: ColorTokenValue;
    card: ColorTokenValue;
    muted: ColorTokenValue;
  };
  text: {
    primary: ColorTokenValue;
    muted: ColorTokenValue;
    inverse: ColorTokenValue;
  };
  danger: {
    bg: ColorTokenValue;
    text: ColorTokenValue;
    border: ColorTokenValue;
  };
  verified: {
    bg: ColorTokenValue;
    text: ColorTokenValue;
    border: ColorTokenValue;
  };
  warning: {
    bg: ColorTokenValue;
    text: ColorTokenValue;
    border: ColorTokenValue;
  };
}

export type ThemeName = "light" | "dark" | "high-contrast" | "print";

export const tokens = tokensData.themes as Record<ThemeName, ThemeTokens>;

export interface TokenPairing {
  id: string;
  name: string;
  usage: string;
  fgToken: string;
  bgToken: string;
  minRatio: number;
  getFg: (t: ThemeTokens) => string;
  getBg: (t: ThemeTokens) => string;
}

function resolveToken(tokens: ThemeTokens, path: string): string {
  const parts = path.split(".");
  let cur: unknown = tokens;
  for (const p of parts) {
    cur = (cur as Record<string, unknown>)[p];
  }
  return (cur as ColorTokenValue).hex;
}

export const documentedPairings: TokenPairing[] = tokensData.pairings.map((p) => ({
  ...p,
  getFg: (t: ThemeTokens) => resolveToken(t, p.fgToken),
  getBg: (t: ThemeTokens) => resolveToken(t, p.bgToken),
}));
