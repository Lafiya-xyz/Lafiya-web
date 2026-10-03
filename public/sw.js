// Lafiya emergency-card offline protocol (envelope v1, encrypted at rest v2).
//
// We intentionally cache a structured, versioned projection rather than the
// rendered HTML. Offline presentation therefore cannot accidentally inherit a
// live-looking verification badge, stale scripts, or an old route layout.
// Envelopes are AES-GCM encrypted under a key derived from the card URL's
// secret segment and stored under an opaque hashed key (issue #630, ADR-004).

import {
  CARD_CACHE_LIMITS,
  cardSecretFromUrl,
  createOfflineEnvelope,
  decryptOfflineEnvelope,
  encryptOfflineEnvelope,
  enforceCacheBudget,
  offlineCacheKey,
  offlineEnvelopeResponse,
  renderOfflineEnvelope,
  validateOfflineEnvelope,
  withEntryMetaHeaders,
} from "./offline-cache-helpers.js";

// v2: encrypted envelopes. Activation deletes the v1 plaintext cache.
const CARD_CACHE = "lafiya-emergency-envelopes-v2";
const CARD_PATH_PREFIX = "/card/";
const PERIODIC_SYNC_TAG = "lafiya-refresh";
const PERIODIC_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

// Web Push (RFC 8291) payloads are decrypted by the browser before they reach
// this handler. Payloads must never contain PHI or capability tokens: only a
// generic title/body plus a same-origin path to open on click.
const PUSH_DEFAULT_TITLE = "Lafiya";
const PUSH_DEFAULT_BODY = "You have a new notification.";
const PUSH_DEFAULT_PATH = "/";

// Card routes that benefit from navigation preload. Kept in sync with the
// offline card renderer routes.
const CARD_ROUTE_PREFIX = "/cards/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load ${MANIFEST_URL}: ${response.status}`);
      }
      const manifest = await response.json();
      const cacheName = `${CACHE_PREFIX}-${manifest.version}`;
      const cache = await caches.open(cacheName);
      await cache.addAll(manifest.assets);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !key.endsWith(currentVersion))
          .map((key) => caches.delete(key)),
      );
      // Enable navigation preload so the browser starts the network request
      // for card navigations in parallel with service-worker boot, removing
      // the worker startup latency from the critical path.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable(NAVIGATION_PRELOAD_HEADER);
      }
      await self.clients.claim();
    })(),
  );
});

// Resolve the active cache version from the manifest so `activate` can prune
// stale revisions without hardcoding a version string.
let currentVersion = null;
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SW_VERSION") {
    currentVersion = event.data.version;
  }
  return fn();
}

async function storeEnvelope(cacheKey, envelope, secret) {
  const record = await encryptOfflineEnvelope(envelope, secret, cacheKey);
  if (!record) return false;
  const request = new Request(new URL(cacheKey, self.location.origin));
  const response = offlineEnvelopeResponse(record);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  return withCacheLock(CARD_CACHE, async () => {
    const cache = await caches.open(CARD_CACHE);
    const { admit } = await enforceCacheBudget({
      cache,
      incomingRequest: request,
      incomingSize: bytes.byteLength,
      maxEntries: CARD_CACHE_LIMITS.maxEntries,
      maxBytes: CARD_CACHE_LIMITS.maxBytes,
    });
    if (!admit) return false;
    const headers = withEntryMetaHeaders(response.headers, {
      cachedAt: envelope.cachedAt,
      lastAccessed: Date.now(),
      size: bytes.byteLength,
    });
    await cache.put(request, new Response(bytes, { headers }));
    return true;
  });
}

// Handle card navigations using the navigation preload response when the
// browser provides one, falling back to a regular fetch. Either path results
// in exactly one server hit, so capability consumption semantics are
// unchanged.
async function handleCardNavigation(event) {
  const request = event.request;
  const secret = cardSecretFromUrl(request.url);
  const cacheKey = secret ? await offlineCacheKey(request.url) : null;
  const cacheRequest = cacheKey
    ? new Request(new URL(cacheKey, self.location.origin))
    : null;
  try {
    const networkResponse = await fetch(request);
    if (!networkResponse.ok) return networkResponse;

    const envelope = await createOfflineEnvelope(
      await networkResponse.clone().text(),
      new Date().toISOString(),
    );
    if (!cacheRequest) return networkResponse;
    const cache = await caches.open(CARD_CACHE);
    if (envelope) {
      await storeEnvelope(cacheKey, envelope, secret);
    } else {
      // Consent withdrawal, malformed source, unsupported envelope version,
      // and unavailable cards remove any prior local copy at next contact.
      await cache.delete(cacheRequest);
    }
    return networkResponse;
  } catch {
    const cache = await caches.open(CARD_CACHE);
    const cached = cacheRequest ? await cache.match(cacheRequest) : undefined;
    const record = cached ? await cached.json().catch(() => null) : null;
    const envelope = await decryptOfflineEnvelope(record, secret, cacheKey);
    const validation = await validateOfflineEnvelope(
      envelope,
      new Date().toISOString(),
    );
    if (!validation.valid) {
      if (cached) event.waitUntil(cache.delete(cacheRequest));
      return new Response(renderOfflineEnvelope(null, validation.reason), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(renderOfflineEnvelope(envelope), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && url.pathname.startsWith(CARD_ROUTE_PREFIX)) {
    event.respondWith(handleCardNavigation(event));
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(`${CACHE_PREFIX}-${currentVersion ?? "latest"}`);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        return response;
      } catch (error) {
        const fallback = await cache.match("/offline.html");
        if (fallback) return fallback;
        throw error;
      }
    })(),
  );
});
