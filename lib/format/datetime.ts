/**
 * Shared date/time formatting (Issue #371).
 *
 * Several components each called toLocaleDateString/toLocaleString
 * independently with slightly different (or no) options, producing
 * visibly inconsistent formatting across pages a patient may view side
 * by side. Use these instead of formatting a Date directly.
 *
 * Issue #601: standardize on Intl-based formatting for Nigerian locales
 * (en-NG, ha-NG, yo-NG, ig-NG) with fallback chains for reduced ICU data,
 * and render dates unambiguously with a spelled-out month (e.g. 05 Mar 2026).
 */

/** Locales we explicitly support, in preference order. */
export const SUPPORTED_LOCALES = ["en-NG", "ha-NG", "yo-NG", "ig-NG"] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Resolve a requested locale to a supported one, falling back to `en-NG`
 * and finally to the runtime default when ICU data is missing.
 */
export function resolveLocale(locale?: string | null): string {
  if (locale) {
    const normalized = locale.trim();
    if (normalized) {
      try {
        // Throws a RangeError when the tag is structurally invalid.
        Intl.getCanonicalLocales(normalized);
        return normalized;
      } catch {
        // fall through to the default below
      }
    }
  }
  return "en-NG";
}

/**
 * Build a formatter, degrading gracefully when the runtime ICU data does
 * not know the requested locale (e.g. a reduced browser ICU build).
 */
function buildFormatter(
  locale: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const resolved = resolveLocale(locale);
  try {
    return new Intl.DateTimeFormat(resolved, options);
  } catch {
    return new Intl.DateTimeFormat("en-NG", options);
  }
}

/**
 * Unambiguous date format with a spelled-out month, e.g. "05 Mar 2026".
 * Avoids the MM/DD vs DD/MM ambiguity that is dangerous on an emergency card.
 */
const unambiguousDateOptions: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "short",
  year: "numeric",
};

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * e.g. "05 Mar 2026, 15:45". Returns `fallback` for a null/invalid input.
 * Pass a locale (e.g. "ha-NG") to format for that audience.
 */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  fallback = "Unavailable",
  locale?: string | null,
): string {
  const date = parseDate(value);
  return date ? buildFormatter(locale, dateTimeOptions).format(date) : fallback;
}

/**
 * e.g. "05 Mar 2026" — unambiguous, no time component.
 * Returns `fallback` for a null/invalid input.
 */
export function formatDate(
  value: string | number | Date | null | undefined,
  fallback = "Unavailable",
  locale?: string | null,
): string {
  const date = parseDate(value);
  return date ? buildFormatter(locale, unambiguousDateOptions).format(date) : fallback;
}
