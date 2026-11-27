/**
 * Issue #926: text direction for supported locales.
 *
 * `ha-Arab` is Hausa written in the Ajami (Arabic) script and is
 * right-to-left. Everything else we ship (en, ha, ig, yo, fr, ar) is
 * resolved from the script subtag so a bare `ar` also flips to RTL.
 *
 * Keep this dependency-free: it runs in the root layout, on the public
 * card route and in the offline envelope, none of which should pull in
 * an i18n runtime.
 */

/** Locales we explicitly support, in preference order. */
export const SUPPORTED_LOCALES = [
  "en-NG",
  "ha-NG",
  "ha-Arab",
  "yo-NG",
  "ig-NG",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type TextDirection = "ltr" | "rtl";

/** Script subtags that render right-to-left. */
const RTL_SCRIPTS = new Set(["arab", "hebr", "thaa", "nkoo", "syrc"]);

/** Primary language subtags that default to a right-to-left script. */
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur", "ps", "sd", "ug"]);

/**
 * Resolve the writing direction for a BCP-47 tag.
 *
 * The script subtag wins when present (`ha-Arab` → rtl, `ha-Latn` → ltr),
 * otherwise the primary language subtag decides. Unknown or malformed
 * tags fall back to `ltr` so a bad header can never break layout.
 */
export function getTextDirection(locale?: string | null): TextDirection {
  if (!locale) return "ltr";

  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(locale.trim())[0] ?? "";
  } catch {
    return "ltr";
  }
  if (!canonical) return "ltr";

  const subtags = canonical.toLowerCase().split("-");
  const script = subtags.find((part) => part.length === 4);
  if (script) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";

  return RTL_LANGUAGES.has(subtags[0]) ? "rtl" : "ltr";
}

/** True when the locale is Hausa written in the Ajami script. */
export function isAjamiLocale(locale?: string | null): boolean {
  if (!locale) return false;
  try {
    const canonical = Intl.getCanonicalLocales(locale.trim())[0] ?? "";
    return /^ha-Arab\b/i.test(canonical);
  } catch {
    return false;
  }
}
