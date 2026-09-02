/**
 * Shared date/time formatting (Issue #371).
 *
 * Several components each called toLocaleDateString/toLocaleString
 * independently with slightly different (or no) options, producing
 * visibly inconsistent formatting across pages a patient may view side
 * by side. Use these instead of formatting a Date directly.
 */

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
});

function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** e.g. "Jan 5, 2026, 3:45 PM". Returns `fallback` for a null/invalid input. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  fallback = "Unavailable",
): string {
  const date = parseDate(value);
  return date ? dateTimeFormatter.format(date) : fallback;
}

/** e.g. "Jan 5, 2026" — no time component. Returns `fallback` for a null/invalid input. */
export function formatDate(
  value: string | number | Date | null | undefined,
  fallback = "Unavailable",
): string {
  const date = parseDate(value);
  return date ? dateFormatter.format(date) : fallback;
}
