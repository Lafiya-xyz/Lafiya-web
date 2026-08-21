// Lafiya offline service worker — scoped to public emergency card pages.
//
// Strategy: "cache after a real visit" (network-first with cache fallback).
// On every successful navigation to /card/* we store the rendered HTML
// together with the time it was fetched. When the network is unavailable we
// serve the last cached copy and inject a visible "Showing cached data as of
// …" banner so a responder knows it may be stale. We never prefetch or cache
// a card the user hasn't actually opened, and we never cache error responses
// (the 404s produced by notFound() included).
//
// Stylesheets used by card pages are cached separately (cache-first) so a
// cached card is still legible offline. JavaScript chunks are intentionally
// NOT cached — that keeps the page from re-hydrating offline and accidentally
// removing the injected banner.
//
// Both caches are bounded (entry count + total bytes) and evict
// least-recently-*accessed* entries first — see offline-cache-helpers.js for
// the accounting/eviction policy and its reasoning.

import {
  CACHED_AT_HEADER,
  CARD_CACHE_LIMITS,
  STYLE_CACHE_LIMITS,
  buildOfflineNavigationResponse,
  enforceCacheBudget,
  withEntryMetaHeaders,
} from "./offline-cache-helpers.js";

const CARD_CACHE = "lafiya-cards-v2";
const STYLE_CACHE = "lafiya-styles-v2";
const CARD_PATH_PREFIX = "/card/";

self.addEventListener("install", () => {
  // Become active immediately so the very first visit starts caching
  // without requiring a reload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CARD_CACHE && key !== STYLE_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 1) Card page navigations: network-first, cache fallback, banner injection.
  if (
    request.mode === "navigate" &&
    url.pathname.startsWith(CARD_PATH_PREFIX)
  ) {
    event.respondWith(handleCardNavigation(event));
    return;
  }

  // 2) Stylesheets referenced by card pages: cache-first so cards stay legible
  //    offline (we deliberately do not cache script chunks — see note above).
  if (request.destination === "style") {
    event.respondWith(cacheFirst(request, STYLE_CACHE, STYLE_CACHE_LIMITS));
  }
});

// Serializes budget-enforcement + write for a given cache name so two
// concurrent fetch events (e.g. two card navigations racing each other)
// can't both decide there's room for their own entry and jointly blow past
// the budget, and can't interleave an eviction with another event's
// last-accessed bump for the same key. Falls back to running inline where
// the Web Locks API isn't available.
async function withCacheLock(name, fn) {
  const locks = self.navigator && self.navigator.locks;
  if (locks && typeof locks.request === "function") {
    return locks.request(`lafiya-cache:${name}`, fn);
  }
  return fn();
}

// Enforce the cache's budget (evicting least-recently-accessed entries as
// needed) and, if the incoming entry is admitted, write it with fresh
// bookkeeping headers. Returns whether it was actually stored.
async function storeWithBudget(cacheName, request, response, limits) {
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  return withCacheLock(cacheName, async () => {
    const cache = await caches.open(cacheName);
    const { admit } = await enforceCacheBudget({
      cache,
      incomingRequest: request,
      incomingSize: bytes.byteLength,
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
    });
    if (!admit) return false;

    const headers = withEntryMetaHeaders(response.headers, {
      cachedAt: new Date().toISOString(),
      lastAccessed: Date.now(),
      size: bytes.byteLength,
    });
    const storable = new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    await cache.put(request, storable);
    return true;
  });
}

// Refresh an existing entry's last-accessed timestamp in place (same body,
// same size) after serving it from cache. Never touches entry count or byte
// total, so no eviction pass is needed here.
async function bumpLastAccessed(cacheName, request, cachedResponse) {
  const bytes = new Uint8Array(await cachedResponse.arrayBuffer());
  const cachedAt =
    cachedResponse.headers.get(CACHED_AT_HEADER) ?? new Date().toISOString();
  await withCacheLock(cacheName, async () => {
    const cache = await caches.open(cacheName);
    const headers = withEntryMetaHeaders(cachedResponse.headers, {
      cachedAt,
      lastAccessed: Date.now(),
      size: bytes.byteLength,
    });
    await cache.put(
      request,
      new Response(bytes, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers,
      }),
    );
  });
}

async function handleCardNavigation(event) {
  const request = event.request;
  try {
    const networkResponse = await fetch(request);

    // Only cache successful renders. 404s (malformed/unknown id via
    // notFound()) and server errors are never stored, so we never serve a
    // stale "not found" or error page from cache.
    if (networkResponse && networkResponse.ok) {
      const html = await networkResponse.clone().text();
      const cache = await caches.open(CARD_CACHE);
      if (html.includes('data-offline-cache="allowed"')) {
        await storeWithBudget(
          CARD_CACHE,
          request,
          networkResponse,
          CARD_CACHE_LIMITS,
        );
      } else {
        // Withdrawal must stop future offline use and remove this browser's
        // prior copy as soon as it next reaches the card online.
        await cache.delete(request);
      }
    }

    return networkResponse;
  } catch {
    // Network failed (dead zone) — fall back to the last cached copy.
    const cache = await caches.open(CARD_CACHE);
    const cached = await cache.match(request);

    let cachedHtml;
    let cachedAt;
    if (cached) {
      cachedAt = cached.headers.get(CACHED_AT_HEADER);
      const bumpSource = cached.clone();
      cachedHtml = await cached.text();
      // Refresh LRU standing in the background — never blocks the response,
      // and the response we already read/built is unaffected either way.
      event.waitUntil(bumpLastAccessed(CARD_CACHE, request, bumpSource));
    }

    // Never visited, or evicted for space (both look identical here) and
    // offline — an honest empty state instead of a spinner that never
    // resolves or a guessed/stale card.
    const { html } = buildOfflineNavigationResponse({ cachedHtml, cachedAt });
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function cacheFirst(request, cacheName, limits) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Serve stale immediately, refresh in the background.
    bumpLastAccessed(cacheName, request, cached.clone()).catch(() => {});
    fetch(request)
      .then((res) => {
        if (res && res.ok)
          storeWithBudget(cacheName, request, res, limits).catch(() => {});
      })
      .catch(() => {});
    return cached;
  }
  try {
    const network = await fetch(request);
    if (network && network.ok) {
      await storeWithBudget(cacheName, request, network.clone(), limits);
    }
    return network;
  } catch {
    return cached ?? Response.error();
  }
}
