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

import { injectOfflineBanner } from "./offline-cache-helpers.js";

const CARD_CACHE = "lafiya-cards-v1";
const STYLE_CACHE = "lafiya-styles-v1";
const CARD_PATH_PREFIX = "/card/";
const CACHED_AT_HEADER = "x-lafiya-cached-at";

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
  if (request.mode === "navigate" && url.pathname.startsWith(CARD_PATH_PREFIX)) {
    event.respondWith(handleCardNavigation(request));
    return;
  }

  // 2) Stylesheets referenced by card pages: cache-first so cards stay legible
  //    offline (we deliberately do not cache script chunks — see note above).
  if (request.destination === "style") {
    event.respondWith(cacheFirst(request, STYLE_CACHE));
  }
});

async function handleCardNavigation(request) {
  try {
    const networkResponse = await fetch(request);

    // Only cache successful renders. 404s (malformed/unknown id via
    // notFound()) and server errors are never stored, so we never serve a
    // stale "not found" or error page from cache.
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(CARD_CACHE);
      const clone = networkResponse.clone();
      const headers = new Headers(clone.headers);
      headers.set(CACHED_AT_HEADER, new Date().toISOString());
      const storable = new Response(await clone.arrayBuffer(), {
        status: clone.status,
        statusText: clone.statusText,
        headers,
      });
      await cache.put(request, storable);
    }

    return networkResponse;
  } catch {
    // Network failed (dead zone) — fall back to the last cached copy.
    const cache = await caches.open(CARD_CACHE);
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = cached.headers.get(CACHED_AT_HEADER);
      const html = injectOfflineBanner(await cached.text(), cachedAt);
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Never visited (or cache cleared) and offline — an honest empty state
    // instead of a spinner that never resolves.
    return new Response(OFFLINE_FALLBACK_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Serve stale immediately, refresh in the background.
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone());
      })
      .catch(() => {});
    return cached;
  }
  try {
    const network = await fetch(request);
    if (network && network.ok) cache.put(request, network.clone());
    return network;
  } catch {
    return cached ?? Response.error();
  }
}

const OFFLINE_FALLBACK_HTML = `<!doctype html>
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
