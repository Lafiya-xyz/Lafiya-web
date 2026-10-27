import { describe, expect, it } from "vitest";
import { tokens, documentedPairings, ThemeName } from "../lib/tokens/tokens";
import { getContrastRatio, getApcaContrast } from "../lib/tokens/contrast";

describe("Design Tokens & Contrast Verification", () => {
  const themes: ThemeName[] = ["light", "dark", "high-contrast", "print"];

  themes.forEach((theme) => {
    describe(`Theme: ${theme}`, () => {
      documentedPairings.forEach((pairing) => {
        it(`passes WCAG 2.2 AA contrast for "${pairing.name}" (>= ${pairing.minRatio}:1)`, () => {
          const themeTokens = tokens[theme];
          const fg = pairing.getFg(themeTokens);
          const bg = pairing.getBg(themeTokens);
          const ratio = getContrastRatio(fg, bg);
          const apca = getApcaContrast(fg, bg);

          expect(ratio).toBeGreaterThanOrEqual(pairing.minRatio);
          expect(apca).toBeGreaterThan(0);
        });
      });
    });
  });
});
