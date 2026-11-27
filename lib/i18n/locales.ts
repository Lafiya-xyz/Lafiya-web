/**
 * Locale registry (issue #925).
 *
 * Nigerian Pidgin (`pcm`) is a supported UI locale. CLDR ships no `pcm`
 * date/number data, so formatting falls back to `en-NG` (see
 * `lib/format/datetime.ts`). Plural rules for `pcm` are the English ones
 * (one / other), which is what Pidgin speakers expect.
 */

/** Locales selectable in the UI, in preference order. */
export const UI_LOCALES = ["en-NG", "pcm", "ha-NG", "yo-NG", "ig-NG"] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = "en-NG";

/** Human-readable names, shown in the locale switcher. */
export const UI_LOCALE_NAMES: Record<UiLocale, string> = {
  "en-NG": "English (Nigeria)",
  pcm: "Naijá (Nigerian Pidgin)",
  "ha-NG": "Hausa",
  "yo-NG": "Yorùbá",
  "ig-NG": "Igbo",
};

/**
 * Locale used for Intl formatting when the requested locale has no CLDR
 * data of its own. `pcm` intentionally maps to `en-NG`.
 */
const INTL_FALLBACKS: Partial<Record<UiLocale, string>> = {
  pcm: "en-NG",
};

/** Plural categories used by `pcm` (identical to English). */
export const PCM_PLURAL_CATEGORIES = ["one", "other"] as const;

export function isUiLocale(value: string | null | undefined): value is UiLocale {
  return !!value && (UI_LOCALES as readonly string[]).includes(value);
}

/**
 * Map a requested locale to the tag Intl should format with, falling back to
 * `en-NG` for unknown or structurally invalid tags.
 */
export function intlLocaleFor(locale?: string | null): string {
  if (!locale) return DEFAULT_UI_LOCALE;
  const normalized = locale.trim();
  if (!normalized) return DEFAULT_UI_LOCALE;
  if (isUiLocale(normalized)) return INTL_FALLBACKS[normalized] ?? normalized;
  try {
    Intl.getCanonicalLocales(normalized);
    return normalized;
  } catch {
    return DEFAULT_UI_LOCALE;
  }
}

/** Pick the plural category for a count in `pcm`. */
export function pcmPluralCategory(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}
