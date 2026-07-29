// Pure, framework-agnostic helpers shared by the offline service worker
// (public/sw.js) and the unit tests. Keep this file free of any Service
// Worker / DOM globals so it can be imported and exercised under Node/vitest.

export const OFFLINE_BANNER_CLASS = "lafiya-offline-banner";

/**
 * Format an ISO timestamp into a human-readable, locale-aware string for the
 * "showing cached data as of …" indicator. Returns a safe fallback for
 * missing or unparseable input — the value we store is always a valid ISO
 * string we generate ourselves, so this is defensive only.
 */
export function formatCachedAt(isoString) {
  if (typeof isoString !== "string" || isoString.length === 0) {
    return "an unknown time";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "an unknown time";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Build the standalone HTML banner shown when a responder is reading a
 * previously-cached card without a network connection. Inline styles are
 * used on purpose: when offline the app's stylesheet may not be available
 * yet, and the indicator must be visible regardless.
 */
export function buildOfflineBannerHtml(isoString) {
  const when = formatCachedAt(isoString);
  return (
    `<div role="alert" aria-live="polite" class="${OFFLINE_BANNER_CLASS}" ` +
    `style="position:sticky;top:0;z-index:50;margin:0;padding:0.75rem 1rem;` +
    `background:#f59e0b;color:#1f2937;font:600 0.875rem/1.4 system-ui,-apple-system,` +
    `Segoe UI,Roboto,sans-serif;text-align:center;border-bottom:1px solid #b45309;">` +
    `Showing cached data as of ${when}. This may be out of date — ` +
    `verify with the patient or facility when you can.` +
    `</div>`
  );
}

/**
 * Inject the offline banner into a cached HTML document so it renders at the
 * top of the page even though the surrounding markup is a stale snapshot.
 * Inserted as the first child of <body>; if there is no <body> we prepend it
 * so the indicator still surfaces.
 */
export function injectOfflineBanner(html, isoString) {
  const banner = buildOfflineBannerHtml(isoString);
  if (typeof html !== "string" || html.length === 0) {
    return banner;
  }
  const match = /<body[^>]*>/i.exec(html);
  if (match) {
    const insertAt = match.index + match[0].length;
    return html.slice(0, insertAt) + banner + html.slice(insertAt);
  }
  return banner + html;
}
