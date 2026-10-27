import React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { tokens, documentedPairings, ThemeName } from "../lib/tokens/tokens";
import { getContrastRatio, getApcaContrast } from "../lib/tokens/contrast";
import { VerifiedBadge } from "../app/(public)/card/[id]/verified-badge";

const meta: Meta = {
  title: "Design System/Tokens",
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

export const DesignTokensOverview: StoryObj = {
  render: () => {
    const themes: ThemeName[] = ["light", "dark", "high-contrast", "print"];

    return (
      <div className="min-h-screen bg-[var(--color-surface,#fff)] p-8 text-[var(--color-text,#171717)] font-sans">
        <header className="mb-8 border-b pb-4">
          <h1 className="text-3xl font-bold">Lafiya Design Token System</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-400">
            Single source of truth for color, surface, and semantic status tokens.
            Automated WCAG 2.2 AA and APCA verification ensures high-fidelity accessibility across light, dark, high-contrast, and print themes.
          </p>
        </header>

        {/* Live Migrated Components Showcase */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4">Migrated Component Previews</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-3 text-zinc-500">Verified Badge (Finalized)</h3>
              <VerifiedBadge status="verified" />
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-3 text-zinc-500">Verified Badge (Pending)</h3>
              <VerifiedBadge status="confirming" />
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-3 text-zinc-500">Verified Badge (Unverified)</h3>
              <VerifiedBadge status="not_verified" />
            </div>
          </div>

          <div className="mt-6 rounded-lg border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4">
            <h3 className="font-semibold text-[var(--color-danger-text)]">Critical Emergency Banner</h3>
            <p className="text-sm text-[var(--color-danger-text)] mt-1">
              Sample critical fields warning rendered with semantic danger tokens.
            </p>
          </div>
        </section>

        {/* Contrast Verification Matrix */}
        <section className="mb-12">
          <h2 className="text-xl font-semibold mb-4">Automated Contrast Verification Matrix</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse border border-zinc-200 dark:border-zinc-800">
              <thead className="bg-zinc-100 dark:bg-zinc-800">
                <tr>
                  <th className="p-3 border">Theme</th>
                  <th className="p-3 border">Token Pairing</th>
                  <th className="p-3 border">Foreground</th>
                  <th className="p-3 border">Background</th>
                  <th className="p-3 border">WCAG Ratio</th>
                  <th className="p-3 border">Target</th>
                  <th className="p-3 border">APCA Lc</th>
                  <th className="p-3 border">Status</th>
                </tr>
              </thead>
              <tbody>
                {themes.flatMap((theme) => {
                  const themeTokens = tokens[theme];
                  return documentedPairings.map((pair) => {
                    const fg = pair.getFg(themeTokens);
                    const bg = pair.getBg(themeTokens);
                    const ratio = getContrastRatio(fg, bg);
                    const apca = getApcaContrast(fg, bg);
                    const passes = ratio >= pair.minRatio;

                    return (
                      <tr key={`${theme}-${pair.id}`} className="border-b">
                        <td className="p-3 border font-mono capitalize">{theme}</td>
                        <td className="p-3 border font-medium">{pair.name}</td>
                        <td className="p-3 border font-mono">
                          <span
                            className="inline-block w-4 h-4 rounded mr-2 border align-middle"
                            style={{ backgroundColor: fg }}
                          />
                          {fg}
                        </td>
                        <td className="p-3 border font-mono">
                          <span
                            className="inline-block w-4 h-4 rounded mr-2 border align-middle"
                            style={{ backgroundColor: bg }}
                          />
                          {bg}
                        </td>
                        <td className="p-3 border font-mono font-bold">
                          {ratio.toFixed(2)}:1
                        </td>
                        <td className="p-3 border font-mono">≥ {pair.minRatio}:1</td>
                        <td className="p-3 border font-mono">Lc {apca}</td>
                        <td className="p-3 border">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-semibold ${
                              passes
                                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                                : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                            }`}
                          >
                            {passes ? "PASS AA" : "FAIL"}
                          </span>
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Token Dictionary */}
        <section>
          <h2 className="text-xl font-semibold mb-4">Token Definitions by Theme</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {themes.map((theme) => {
              const t = tokens[theme];
              return (
                <div key={theme} className="rounded-lg border p-6">
                  <h3 className="text-lg font-bold capitalize mb-4">{theme} Tokens</h3>
                  <div className="space-y-4">
                    <div>
                      <h4 className="text-xs uppercase text-zinc-400 font-semibold mb-2">Surface</h4>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span>surface.background</span>
                          <span className="font-mono">{t.surface.background.hex}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>surface.card</span>
                          <span className="font-mono">{t.surface.card.hex}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>surface.muted</span>
                          <span className="font-mono">{t.surface.muted.hex}</span>
                        </div>
                      </div>
                    </div>

                    <div>
                      <h4 className="text-xs uppercase text-zinc-400 font-semibold mb-2">Semantic Status</h4>
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span>verified (bg / text / border)</span>
                          <span className="font-mono">
                            {t.verified.bg.hex} / {t.verified.text.hex} / {t.verified.border.hex}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>warning (bg / text / border)</span>
                          <span className="font-mono">
                            {t.warning.bg.hex} / {t.warning.text.hex} / {t.warning.border.hex}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>danger (bg / text / border)</span>
                          <span className="font-mono">
                            {t.danger.bg.hex} / {t.danger.text.hex} / {t.danger.border.hex}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  },
};
