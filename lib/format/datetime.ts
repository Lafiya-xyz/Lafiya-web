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
 * Issue #893: timezone-aware helpers.
 *
 * Every expiry/validity decision must go through these instead of comparing
 * `Date.now()` against a locally-parsed string, so the result is identical
 * regardless of the process TZ (CI runs under TZ=Pacific/Kiritimati and
 * TZ=America/Los_Angeles).
 */

/** Current instant in epoch milliseconds. Single seam for "now". */
export function nowMs(): number {
  return Date.now();
}

/**
 * Parse a timestamp into epoch milliseconds. Accepts ISO-8601 strings (with
 * or without an explicit offset — offset-less values are treated as UTC, never
 * as local time), epoch seconds/milliseconds, and Date instances.
 * Returns `null` for null/invalid input.
 */
export function parseInstant(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Heuristic: values below 1e11 are epoch seconds (year < 5138 in ms).
    return Math.abs(value) < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Offset-less ISO strings are UTC by contract; append Z so the runtime does
  // not fall back to the host timezone.
  const normalized = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * True when `expiresAt` is at or before `now` (defaults to the current
 * instant). Invalid or missing expiries are treated as expired so a malformed
 * value can never grant access.
 */
export function isExpired(
  expiresAt: string | number | Date | null | undefined,
  now: string | number | Date = nowMs(),
): boolean {
  const expiry = parseInstant(expiresAt);
  if (expiry === null) return true;
  const reference = parseInstant(now);
  if (reference === null) return true;
  return expiry <= reference;
}

/** True when `expiresAt` is strictly after `now` (defaults to now). */
export function isNotExpired(
  expiresAt: string | number | Date | null | undefined,
  now: string | number | Date = nowMs(),
): boolean {
  return !isExpired(expiresAt, now);
}

/** ISO-8601 UTC string for an instant, e.g. "2026-03-05T15:45:00.000Z". */
export function toUtcIso(value: string | number | Date | null | undefined): string | null {
  const ms = parseInstant(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** ISO-8601 UTC string for `now + ttlMs`, used when minting expiries. */
export function isoAfter(ttlMs: number, now: string | number | Date = nowMs()): string {
  const reference = parseInstant(now) ?? nowMs();
  return new Date(reference + ttlMs).toISOString();
}

/** Calendar date (YYYY-MM-DD) in UTC — for `date` columns, never local time. */
export function toUtcDateString(value: string | number | Date | null | undefined): string | null {
  const ms = parseInstant(value);
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
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
