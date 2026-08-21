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

// ---------------------------------------------------------------------------
// Bounded cache accounting (entry-count + total-byte budget, LRU eviction).
//
// Cache Storage has no built-in TTL/LRU/size primitives, and we deliberately
// do NOT maintain a separate index (in IndexedDB or otherwise) to track it.
// A separate index can desync from the cache it describes if the service
// worker is terminated between "update the index" and "update the cache" —
// exactly the failure mode the eviction policy has to survive. Instead, the
// bookkeeping (last-accessed time, byte size) travels as headers on the
// cached Response itself, written in the *same* cache.put() call that stores
// the body. A single cache.put() is all-or-nothing (the spec requires the
// full body be buffered before the entry becomes visible to match()/keys()),
// so there is no intermediate state where content and metadata disagree —
// there is simply nothing else for the metadata to disagree with.
// ---------------------------------------------------------------------------

export const CACHED_AT_HEADER = "x-lafiya-cached-at";
export const LAST_ACCESSED_HEADER = "x-lafiya-last-accessed";
export const BODY_SIZE_HEADER = "x-lafiya-body-size";

// Defaults, sized against docs/perf-budget.md's per-card transfer budget
// (<=110 kB compressed, worst case with a photo). Cache Storage holds the
// decompressed HTML the response body is constructed from, and the photo
// itself is never cached by the service worker (it's a separate <img>
// request, not part of the navigation response) — so real per-entry cost is
// well under that ceiling. We budget for ~50 kB/entry average to leave
// headroom, which yields:
//   - maxEntries: 60   — a CHW/responder visiting ~20-30 distinct patient
//     cards a day (per the README's clinic-tablet / shared-device scenario)
//     gets 2-3 days of headroom before the count cap alone would evict
//     anything, and bounds the per-write enumeration cost (we list every
//     entry's headers on each write) to a small, fixed number.
//   - maxBytes: 3 MiB  — 60 * ~50 kB, comfortably inside what a low-end
//     Android device's storage-pressure eviction would tolerate for a single
//     origin (Chrome's origin quota is normally a percentage of free disk
//     space in the hundreds of MB to GB range even on cheap devices), while
//     being small enough that this cache is never the reason the browser
//     evicts the origin's storage wholesale.
export const CARD_CACHE_LIMITS = Object.freeze({
  maxEntries: 60,
  maxBytes: 3 * 1024 * 1024,
});

// Stylesheets are keyed by Next.js's build-hash filenames, so a new deploy
// produces brand-new URLs rather than overwriting old ones — the same
// unbounded-growth bug applies here, just slower (bounded by deploy
// frequency instead of patient visits). Only the current deploy's chunk(s)
// are ever useful; a couple of prior versions is generous slack.
export const STYLE_CACHE_LIMITS = Object.freeze({
  maxEntries: 6,
  maxBytes: 300 * 1024,
});

/**
 * Read the last-accessed timestamp (epoch ms) and body size (bytes) that
 * were stamped onto a cached Response's headers. Missing/unparseable values
 * default to 0 (i.e. "oldest possible" / "weighs nothing") — defensive only,
 * since every entry this module writes always has both headers; this path
 * matters if the cache format ever changes without a cache-name bump.
 */
export function readEntryMeta(headers) {
  const lastAccessed = Number(headers.get(LAST_ACCESSED_HEADER));
  const size = Number(headers.get(BODY_SIZE_HEADER));
  return {
    lastAccessed: Number.isFinite(lastAccessed) ? lastAccessed : 0,
    size: Number.isFinite(size) ? size : 0,
  };
}

/**
 * Build a new Headers instance carrying the cached-at display timestamp plus
 * the last-accessed/size bookkeeping fields, preserving whatever headers
 * (Content-Type etc.) the source response already had.
 */
export function withEntryMetaHeaders(
  sourceHeaders,
  { cachedAt, lastAccessed, size },
) {
  const headers = new Headers(sourceHeaders);
  headers.set(CACHED_AT_HEADER, cachedAt);
  headers.set(LAST_ACCESSED_HEADER, String(lastAccessed));
  headers.set(BODY_SIZE_HEADER, String(size));
  return headers;
}

/**
 * Pure eviction planner. Given the *other* entries already in a cache (never
 * including the entry about to be written — the caller excludes it) plus the
 * size of the incoming entry, decide which existing entries must be evicted,
 * least-recently-accessed first, to keep the cache within budget, and
 * whether the incoming entry can be admitted at all.
 *
 * `protectedKeys` are never chosen as eviction victims (e.g. an entry
 * currently being served to an in-flight request) — if the budget can't be
 * met without evicting a protected key, admission fails instead.
 *
 * An incoming entry larger than maxBytes on its own can never be admitted,
 * no matter how much is evicted — the caller should simply not cache it.
 *
 * @param {{
 *   entries: Array<{ key: string, size: number, lastAccessed: number }>,
 *   incomingSize: number,
 *   maxEntries: number,
 *   maxBytes: number,
 *   protectedKeys?: string[],
 * }} options
 */
export function planCacheAdmission({
  entries,
  incomingSize,
  maxEntries,
  maxBytes,
  protectedKeys = [],
}) {
  if (incomingSize > maxBytes) {
    return { admit: false, toEvict: [] };
  }

  const protectedSet = new Set(protectedKeys);
  const kept = new Map(entries.map((entry) => [entry.key, entry]));
  const evictionOrder = entries
    .filter((entry) => !protectedSet.has(entry.key))
    .slice()
    .sort((a, b) => a.lastAccessed - b.lastAccessed);

  const totalSize = () =>
    incomingSize +
    Array.from(kept.values()).reduce((sum, entry) => sum + entry.size, 0);
  const totalCount = () => kept.size + 1;

  const toEvict = [];
  for (const candidate of evictionOrder) {
    if (totalSize() <= maxBytes && totalCount() <= maxEntries) break;
    if (!kept.has(candidate.key)) continue;
    kept.delete(candidate.key);
    toEvict.push(candidate.key);
  }

  const admit = totalSize() <= maxBytes && totalCount() <= maxEntries;
  return { admit, toEvict };
}

/**
 * Orchestrate planCacheAdmission against a real (or fake, for tests)
 * Cache-like object exposing async keys()/match()/put()/delete(). Evicts
 * whatever planCacheAdmission decides must go and reports whether the
 * incoming entry may be written.
 *
 * Each cache.delete() below is its own atomic operation — if the caller (or
 * the browser) terminates midway through the loop, every delete that has
 * already resolved is permanently applied and every one that hasn't simply
 * never happened. There is no partial/corrupt entry possible, and a retried
 * call converges the cache to the same target state (idempotent).
 *
 * @param {{
 *   cache: {
 *     keys: () => Promise<Array<{ url: string }>>,
 *     match: (request: any) => Promise<Response | undefined>,
 *     put: (request: any, response: Response) => Promise<void>,
 *     delete: (request: any) => Promise<boolean>,
 *   },
 *   incomingRequest: { url: string } | string,
 *   incomingSize: number,
 *   maxEntries: number,
 *   maxBytes: number,
 *   protectedKeys?: string[],
 * }} options
 */
export async function enforceCacheBudget({
  cache,
  incomingRequest,
  incomingSize,
  maxEntries,
  maxBytes,
  protectedKeys = [],
}) {
  const incomingUrl =
    typeof incomingRequest === "string" ? incomingRequest : incomingRequest.url;

  const keys = await cache.keys();
  const candidates = [];
  for (const key of keys) {
    const keyUrl = key.url;
    if (keyUrl === incomingUrl) continue;
    const response = await cache.match(key);
    if (!response) continue;
    candidates.push({ key, keyUrl, ...readEntryMeta(response.headers) });
  }

  const plan = planCacheAdmission({
    entries: candidates.map(({ keyUrl, size, lastAccessed }) => ({
      key: keyUrl,
      size,
      lastAccessed,
    })),
    incomingSize,
    maxEntries,
    maxBytes,
    protectedKeys,
  });

  const victims = candidates.filter((entry) =>
    plan.toEvict.includes(entry.keyUrl),
  );
  const evicted = [];
  for (const victim of victims) {
    await cache.delete(victim.key);
    evicted.push(victim.keyUrl);
  }

  return { admit: plan.admit, evicted };
}

// ---------------------------------------------------------------------------
// Offline-navigation response shaping (shared by the "network failed, serve
// from cache" path in sw.js). Kept here, and exercised directly by tests, so
// the "evicted card -> honest fallback, not a crash" invariant is verified
// against the same decision logic sw.js actually runs, not a re-description
// of it.
// ---------------------------------------------------------------------------

export const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lafiya — offline</title>
</head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e5e7eb;">
<div style="max-width:32rem;margin:0 auto;padding:3rem 1.5rem;">
<h1 style="color:#f59e0b;">No cached card available</h1>
<p>This emergency card hasn't been opened on this device before, so there's nothing to show without a network connection.</p>
<p>Open the card once while online and it will be saved automatically — then it's readable in a dead zone.</p>
</div>
</body>
</html>`;

/**
 * Decide what HTML to serve for an offline card navigation: the cached
 * document with the "showing cached data" banner injected, or the honest
 * "no cached card available" fallback if there's nothing cached for this id
 * (never-visited, or evicted — both are indistinguishable, and both must
 * produce this same honest state rather than a guessed/partial card).
 */
export function buildOfflineNavigationResponse({ cachedHtml, cachedAt }) {
  if (typeof cachedHtml === "string" && cachedHtml.length > 0) {
    return { html: injectOfflineBanner(cachedHtml, cachedAt), fromCache: true };
  }
  return { html: OFFLINE_FALLBACK_HTML, fromCache: false };
}

// ---------------------------------------------------------------------------
// Versioned offline envelope protocol (Epic #174)
// ---------------------------------------------------------------------------

export const OFFLINE_ENVELOPE_VERSION = 1;
export const OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const OFFLINE_SOURCE_ID = "lafiya-offline-envelope-source";

function canonicalEnvelopePayload(value) {
  return JSON.stringify(value);
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function extractSourceHtml(html) {
  if (typeof html !== "string" || html.length > 128 * 1024) return null;
  const match = new RegExp(
    `<script[^>]*id=["']${OFFLINE_SOURCE_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i",
  ).exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function validProjection(projection) {
  const validString = (value, max = 200) =>
    value === null || (typeof value === "string" && value.length <= max);
  const validList = (value) =>
    value === null ||
    (Array.isArray(value) &&
      value.length <= 20 &&
      value.every((item) => typeof item === "string" && item.length <= 200));
  const validContacts =
    projection?.emergencyContacts === null ||
    (Array.isArray(projection?.emergencyContacts) &&
      projection.emergencyContacts.length <= 3 &&
      projection.emergencyContacts.every(
        (contact) =>
          contact &&
          typeof contact === "object" &&
          validString(contact.name) &&
          validString(contact.phone, 32) &&
          validString(contact.relationship),
      ));
  return (
    projection &&
    typeof projection === "object" &&
    !Array.isArray(projection) &&
    validString(projection.name) &&
    validString(projection.bloodGroup, 8) &&
    validString(projection.genotype, 8) &&
    validString(projection.language) &&
    (projection.age === null || Number.isInteger(projection.age)) &&
    validList(projection.allergies) &&
    validList(projection.medications) &&
    validList(projection.chronicConditions) &&
    validContacts
  );
}

/** Extract and integrity-protect the server-rendered source; null denies cache admission. */
export async function createOfflineEnvelope(html, cachedAt) {
  const source = extractSourceHtml(html);
  if (
    !source ||
    source.version !== OFFLINE_ENVELOPE_VERSION ||
    source.offlineAllowed !== true ||
    !validProjection(source.projection) ||
    typeof source.authorizationExpiresAt !== "string" ||
    typeof source.recordUpdatedAt !== "string" ||
    !source.trust ||
    typeof source.trust !== "object" ||
    typeof source.trust.state !== "string" ||
    (source.trust.updatedAt !== null &&
      typeof source.trust.updatedAt !== "string")
  ) {
    return null;
  }
  const payload = {
    version: OFFLINE_ENVELOPE_VERSION,
    authorizationKind:
      source.authorizationKind === "capability" ? "capability" : "legacy",
    authorizationExpiresAt: source.authorizationExpiresAt,
    recordUpdatedAt: source.recordUpdatedAt,
    trust: {
      state: source.trust.state,
      updatedAt: source.trust.updatedAt ?? null,
    },
    projection: source.projection,
    cachedAt,
  };
  const integrity = await sha256(canonicalEnvelopePayload(payload));
  if (!integrity) return null;
  return { ...payload, integrity };
}

export async function validateOfflineEnvelope(envelope, nowIso) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.version !== OFFLINE_ENVELOPE_VERSION ||
    typeof envelope.integrity !== "string" ||
    !validProjection(envelope.projection)
  ) {
    return { valid: false, reason: "corrupted" };
  }
  const { integrity, ...payload } = envelope;
  const expected = await sha256(canonicalEnvelopePayload(payload));
  if (!expected || expected !== integrity)
    return { valid: false, reason: "corrupted" };
  const now = new Date(nowIso).getTime();
  const cachedAt = new Date(envelope.cachedAt).getTime();
  const authorizationExpiry = new Date(
    envelope.authorizationExpiresAt,
  ).getTime();
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(cachedAt) ||
    !Number.isFinite(authorizationExpiry)
  ) {
    return { valid: false, reason: "corrupted" };
  }
  if (now - cachedAt > OFFLINE_MAX_AGE_MS || now >= authorizationExpiry) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, reason: null };
}

export function offlineEnvelopeResponse(envelope) {
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function displayList(value) {
  if (value === null) return "Withheld by patient";
  return value.length ? value.map(escapeHtml).join(", ") : "None recorded";
}

function displayTime(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "Unavailable" : time.toLocaleString();
}

/** Deliberately simple, self-contained, unhydrated offline presentation. */
export function renderOfflineEnvelope(envelope, reason = null) {
  if (!envelope) {
    const expired = reason === "expired";
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lafiya — offline</title><body style="font:16px/1.5 system-ui;margin:0;background:#0b1020;color:#f8fafc"><main style="max-width:42rem;margin:auto;padding:2rem 1.25rem"><h1>${expired ? "Cached card needs reconnection" : "No safe cached card available"}</h1><p>${expired ? "This cached emergency card is older than Lafiya’s safety window or its authorization has expired. Reconnect to check current access and record information." : "This card has not been safely cached on this device, or its saved data was corrupted. Reconnect to retrieve it."}</p></main></body></html>`;
  }
  const p = envelope.projection;
  const contacts =
    p.emergencyContacts === null
      ? "Withheld by patient"
      : p.emergencyContacts
          .map(
            (contact) =>
              `<li><strong>${escapeHtml(contact.name ?? "Emergency contact")}</strong> — ${escapeHtml(contact.relationship ?? "")}: ${escapeHtml(contact.phone ?? "Unavailable")}</li>`,
          )
          .join("") || "None recorded";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lafiya — cached emergency card</title><body style="font:16px/1.5 system-ui;margin:0;background:#fff;color:#18181b"><aside role="alert" style="padding:1rem;background:#fef3c7;color:#78350f;border-bottom:1px solid #d97706"><strong>Cached emergency information.</strong> Cached on ${escapeHtml(displayTime(envelope.cachedAt))}. Current authorization and revocation cannot be checked offline. Record updated: ${escapeHtml(displayTime(envelope.recordUpdatedAt))}. Verification evidence last observed: ${escapeHtml(displayTime(envelope.trust.updatedAt))}.</aside><main style="max-width:42rem;margin:auto;padding:1.5rem"><h1>${escapeHtml(p.name ?? "Name withheld")}</h1>${p.age === null ? "" : `<p>${escapeHtml(p.age)} years old</p>`}<h2>Critical emergency information</h2><dl><dt>Blood group</dt><dd>${escapeHtml(p.bloodGroup ?? "Withheld")}</dd><dt>Genotype</dt><dd>${escapeHtml(p.genotype ?? "Withheld")}</dd></dl><h2>Allergies</h2><p>${displayList(p.allergies)}</p><h2>Current medications</h2><p>${displayList(p.medications)}</p><h2>Chronic conditions / implants</h2><p>${displayList(p.chronicConditions)}</p><h2>Emergency contacts</h2><ul>${contacts}</ul>${p.language ? `<h2>Language spoken</h2><p>${escapeHtml(p.language)}</p>` : ""}<p style="font-size:.875rem;color:#52525b">Not a medical device. Not a substitute for professional medical judgment.</p></main></body></html>`;
}
