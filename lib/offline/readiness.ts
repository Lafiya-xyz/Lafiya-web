/**
 * Offline-card readiness and eviction detection (Issue #875).
 *
 * WebKit ITP deletes all script-writable storage (Cache Storage, IndexedDB,
 * localStorage) for a site that hasn't been interacted with in 7 days of
 * browser use, unless it runs as an installed home-screen app. Other browsers
 * can also evict best-effort storage under pressure. This module inspects the
 * service worker's envelope cache from the page and compares it against a
 * small local marker so a lost offline copy is reported instead of failing
 * silently. See docs/card-caching-strategy.md > "Storage eviction".
 */

/** Kept in sync with `CARD_CACHE` in public/sw.js. */
export const CARD_ENVELOPE_CACHE = "lafiya-emergency-envelopes-v2";
/** Kept in sync with `CACHED_AT_HEADER` in public/offline-cache-helpers.js. */
const CACHED_AT_HEADER = "x-lafiya-cached-at";
/** Kept in sync with `OFFLINE_MAX_AGE_MS` in public/offline-cache-helpers.js. */
export const OFFLINE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export const READINESS_MARKER_KEY = "lafiya-offline-readiness-v1";

export type ReadinessState =
  "ready" | "stale" | "evicted" | "missing" | "unsupported";
export type StoragePlatform = "ios-installed" | "ios-tab" | "other";

export type ReadinessMarker = {
  /** Newest envelope `cachedAt` (ms) observed on this device. */
  lastEnvelopeAt: number;
  /** When an envelope was last confirmed present (ms). */
  lastVerifiedAt: number;
};

export type ReadinessReport = {
  state: ReadinessState;
  platform: StoragePlatform;
  newestCachedAt: number | null;
  marker: ReadinessMarker | null;
};

/** Pure classification so it can be unit-tested without browser APIs. */
export function assessReadiness(
  cachedAt: number[],
  marker: ReadinessMarker | null,
  now: number = Date.now(),
): {
  state: Exclude<ReadinessState, "unsupported">;
  newestCachedAt: number | null;
} {
  const valid = cachedAt.filter((t) => Number.isFinite(t));
  if (valid.length === 0) {
    return { state: marker ? "evicted" : "missing", newestCachedAt: null };
  }
  const newestCachedAt = Math.max(...valid);
  return {
    state: now - newestCachedAt > OFFLINE_MAX_AGE_MS ? "stale" : "ready",
    newestCachedAt,
  };
}

export function detectStoragePlatform(env: {
  userAgent: string;
  maxTouchPoints?: number;
  standalone: boolean;
}): StoragePlatform {
  const isIos =
    /iPad|iPhone|iPod/.test(env.userAgent) ||
    (/Macintosh/.test(env.userAgent) && (env.maxTouchPoints ?? 0) > 1);
  if (!isIos) return "other";
  return env.standalone ? "ios-installed" : "ios-tab";
}

function readMarker(): ReadinessMarker | null {
  try {
    const raw = window.localStorage.getItem(READINESS_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReadinessMarker;
    return Number.isFinite(parsed?.lastEnvelopeAt) ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(marker: ReadinessMarker | null) {
  try {
    if (marker)
      window.localStorage.setItem(READINESS_MARKER_KEY, JSON.stringify(marker));
    else window.localStorage.removeItem(READINESS_MARKER_KEY);
  } catch {
    // Storage blocked (private mode); the check still reports cache state.
  }
}

/** Browser-side readiness check. Only reads cache metadata, never envelopes. */
export async function checkOfflineReadiness(
  now: number = Date.now(),
): Promise<ReadinessReport> {
  const platform = detectStoragePlatform({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone:
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true,
  });
  if (typeof caches === "undefined") {
    return {
      state: "unsupported",
      platform,
      newestCachedAt: null,
      marker: null,
    };
  }

  const cachedAt: number[] = [];
  if (await caches.has(CARD_ENVELOPE_CACHE)) {
    const cache = await caches.open(CARD_ENVELOPE_CACHE);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const header = response?.headers.get(CACHED_AT_HEADER);
      if (header) cachedAt.push(Date.parse(header));
    }
  }

  const previous = readMarker();
  const { state, newestCachedAt } = assessReadiness(cachedAt, previous, now);
  const marker =
    newestCachedAt !== null
      ? { lastEnvelopeAt: newestCachedAt, lastVerifiedAt: now }
      : previous;
  writeMarker(marker);
  return { state, platform, newestCachedAt, marker };
}

/** Acknowledge an eviction warning so it isn't shown again until next save. */
export function clearReadinessMarker() {
  writeMarker(null);
}
