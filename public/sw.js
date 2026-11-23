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
import { openVaultStore, vaultCard, wipeIfExpired } from "./shift-vault.js";

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
// offline card renderer routes (app/(public)/card/[id]).
const CARD_ROUTE_PREFIX = "/card/";

// Captive portal / zero-rated detection (issue #872). Mirrors
// lib/offline/connectivity.ts.
const CARD_NAVIGATION_BUDGET_MS = 2500;
const ORIGIN_MARKER_HEADER = "x-lafiya-origin";
const CONNECTIVITY_MESSAGE = "LAFIYA_CONNECTIVITY";
const CONNECTIVITY_BANNERS = {
  captive:
    "You are on a sign-in network (captive portal). Showing the cached card; sign in to the network to load current information.",
  degraded:
    "The network is too slow right now. Showing the cached card.",
};

// Offline packs (issue #876). Mirrors lib/offline/packs.ts.
const PACK_POINTER_CACHE = "lafiya-packs";
const PACK_CACHE_PREFIX = "lafiya-pack-";
const PACK_MANIFEST_PATH = "/__lafiya-pack-manifest/";
const PACK_POINTER_PATH = "/__lafiya-pack-current/";
const MAX_PACK_ATTEMPTS = 3;

// Nearest-facility directory shards (issue #763). Cached lazily on first use
// in their own cache so app-shell version bumps do not evict them.
const FACILITY_CACHE = "lafiya-facilities-v1";
const FACILITY_PATH_PREFIX = "/facilities/";

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
      // Issue #873: wipe an expired responder shift vault even if the tab
      // that started it was closed.
      await wipeIfExpired(openVaultStore()).catch(() => {});
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

// Broadcast the network classification so pages can show a banner.
async function broadcastConnectivity(state) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: CONNECTIVITY_MESSAGE, state });
  }
}

// Races the network against the budget. Resolves to { response } or
// { timedOut } / { error }; a late response is still delivered via `late`.
function fetchWithinBudget(request, budgetMs) {
  const network = fetch(request);
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, late: network }), budgetMs);
  });
  return Promise.race([
    network.then(
      (response) => ({ response }),
      () => ({ error: true }),
    ),
    budget,
  ]).finally(() => clearTimeout(timer));
}

// First-party card responses carry the proxy.ts origin marker; captive
// portal pages (HTTP 200 HTML for every request) do not.
function isFirstPartyResponse(response) {
  return (
    response.type !== "opaque" &&
    response.headers.get(ORIGIN_MARKER_HEADER) === "1"
  );
}

function withConnectivityBanner(html, state) {
  const text = CONNECTIVITY_BANNERS[state];
  if (!text) return html;
  const banner = `<aside role="status" data-connectivity="${state}" style="padding:1rem;background:#1e3a8a;color:#fff">${text}</aside>`;
  return html.replace(/<body[^>]*>/, (body) => body + banner);
}

async function cacheCardResponse(networkResponse, cacheKey, cacheRequest, secret) {
  const envelope = await createOfflineEnvelope(
    await networkResponse.clone().text(),
    new Date().toISOString(),
  );
  if (!cacheRequest) return;
  const cache = await caches.open(CARD_CACHE);
  if (envelope) {
    await storeEnvelope(cacheKey, envelope, secret);
    // Issue #873: keep the card in the responder shift vault, if active.
    await vaultCard(openVaultStore(), {
      path: new URL(networkResponse.url || self.location.href).pathname,
      envelope,
    }).catch(() => false);
  } else {
    // Consent withdrawal, malformed source, unsupported envelope version,
    // and unavailable cards remove any prior local copy at next contact.
    await cache.delete(cacheRequest);
  }
}

async function serveCachedEnvelope(event, cacheKey, cacheRequest, secret, state) {
  const cache = await caches.open(CARD_CACHE);
  const cached = cacheRequest ? await cache.match(cacheRequest) : undefined;
  const record = cached ? await cached.json().catch(() => null) : null;
  const envelope = await decryptOfflineEnvelope(record, secret, cacheKey);
  const validation = await validateOfflineEnvelope(
    envelope,
    new Date().toISOString(),
  );
  if (!validation.valid && cached) event.waitUntil(cache.delete(cacheRequest));
  const html = validation.valid
    ? renderOfflineEnvelope(envelope)
    : renderOfflineEnvelope(null, validation.reason);
  return new Response(withConnectivityBanner(html, state), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// Handle card navigations. The network is raced against a budget (issue
// #872) and responses are validated before they are trusted or cached; a
// captive-portal page is never cached and never wipes a cached envelope.
// Either path results in exactly one server hit, so capability consumption
// semantics are unchanged.
async function handleCardNavigation(event) {
  const request = event.request;
  const secret = cardSecretFromUrl(request.url);
  const cacheKey = secret ? await offlineCacheKey(request.url) : null;
  const cacheRequest = cacheKey
    ? new Request(new URL(cacheKey, self.location.origin))
    : null;

  const result = await fetchWithinBudget(request, CARD_NAVIGATION_BUDGET_MS);
  const networkResponse = result.response;
  if (networkResponse && networkResponse.type === "opaqueredirect") {
    return networkResponse;
  }
  if (networkResponse && isFirstPartyResponse(networkResponse)) {
    event.waitUntil(broadcastConnectivity("online"));
    if (networkResponse.ok) {
      event.waitUntil(
        cacheCardResponse(networkResponse.clone(), cacheKey, cacheRequest, secret),
      );
    }
    return networkResponse;
  }

  if (result.late) {
    // Keep a slow-but-genuine response for next time without blocking now.
    event.waitUntil(
      result.late
        .then((late) =>
          late.ok && isFirstPartyResponse(late)
            ? cacheCardResponse(late, cacheKey, cacheRequest, secret)
            : undefined,
        )
        .catch(() => {}),
    );
  }
  const state = networkResponse ? "captive" : result.timedOut ? "degraded" : "offline";
  event.waitUntil(broadcastConnectivity(state));
  return serveCachedEnvelope(event, cacheKey, cacheRequest, secret, state);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith(FACILITY_PATH_PREFIX) && url.pathname.endsWith(".json")) {
    event.respondWith(handleFacilityShard(request));
    return;
  }

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

// Network-first so fresh shards replace stale ones; falls back to the cached
// shard when offline.
async function handleFacilityShard(request) {
  const cache = await caches.open(FACILITY_CACHE);
  try {
    const response = await fetch(request);
    const isJson = (response.headers.get("Content-Type") ?? "").includes(
      "application/json",
    );
    if (response.ok && isJson) {
      await cache.put(request, response.clone());
      return response;
    }
    // Not a genuine shard (e.g. captive-portal HTML): prefer the cached copy.
    const cached = await cache.match(request);
    return cached ?? response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Offline packs via Background Fetch (issue #876).
//
// The page verifies the signed manifest and stores it in PACK_POINTER_CACHE
// before registering the fetch, so this handler can verify and commit after
// the tab is closed. Each chunk is hash-checked before it is staged in the
// version cache; corrupted chunks are rejected and re-fetched (up to
// MAX_PACK_ATTEMPTS). The pointer is flipped only once every chunk is
// staged, so readers never see a half-updated pack.
// ---------------------------------------------------------------------------

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function parsePackFetchId(id) {
  const match = /^(pack:[^#]+)(?:#retry(\d+))?$/.exec(id);
  return match ? { baseId: match[1], attempt: Number(match[2] ?? 0) } : null;
}

async function commitPack(manifest) {
  const cacheName = `${PACK_CACHE_PREFIX}${manifest.name}-${manifest.version}`;
  const staged = await caches.open(cacheName);
  for (let i = 0; i < manifest.chunks.length; i++) {
    if (!(await staged.match(`${manifest.url}#chunk=${i}`))) return false;
  }
  const pointers = await caches.open(PACK_POINTER_CACHE);
  await pointers.put(
    PACK_POINTER_PATH + manifest.name,
    new Response(JSON.stringify({ version: manifest.version, manifest }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
  for (const key of await caches.keys()) {
    if (key.startsWith(`${PACK_CACHE_PREFIX}${manifest.name}-`) && key !== cacheName) {
      await caches.delete(key);
    }
  }
  return true;
}

async function handlePackFetch(registration) {
  const parsed = parsePackFetchId(registration.id);
  if (!parsed) return;
  const pointers = await caches.open(PACK_POINTER_CACHE);
  const stored = await pointers.match(PACK_MANIFEST_PATH + parsed.baseId);
  const manifest = stored ? await stored.json().catch(() => null) : null;
  if (!manifest) return;
  const staged = await caches.open(
    `${PACK_CACHE_PREFIX}${manifest.name}-${manifest.version}`,
  );

  const retry = [];
  for (const record of await registration.matchAll()) {
    const range = /bytes=(\d+)-/.exec(record.request.headers.get("Range") ?? "");
    const index = manifest.chunks.findIndex(
      (c) => range && c.offset === Number(range[1]),
    );
    if (index < 0) continue;
    const chunk = manifest.chunks[index];
    const response = await record.responseReady.catch(() => null);
    let data = response && response.ok ? await response.arrayBuffer() : null;
    if (data && response.status === 200) {
      data = data.slice(chunk.offset, chunk.offset + chunk.length);
    }
    if (
      data &&
      data.byteLength === chunk.length &&
      (await sha256Hex(data)) === chunk.sha256
    ) {
      await staged.put(`${manifest.url}#chunk=${index}`, new Response(data));
    } else {
      retry.push(record.request);
    }
  }

  if (retry.length > 0 && parsed.attempt + 1 < MAX_PACK_ATTEMPTS) {
    await self.registration.backgroundFetch.fetch(
      `${parsed.baseId}#retry${parsed.attempt + 1}`,
      retry.map((req) => new Request(req.url, { headers: req.headers })),
      { title: `Lafiya offline pack: ${manifest.name}` },
    );
    return;
  }
  if (await commitPack(manifest)) {
    await pointers.delete(PACK_MANIFEST_PATH + parsed.baseId);
    if (registration.updateUI) {
      await registration.updateUI({ title: `Offline pack ready: ${manifest.name}` });
    }
  }
}

self.addEventListener("backgroundfetchsuccess", (event) => {
  event.waitUntil(handlePackFetch(event.registration));
});

// Failed/aborted fetches keep their verified chunks staged; the page resumes
// the remaining chunks with the range-request fallback on next visit.
self.addEventListener("backgroundfetchfail", (event) => {
  event.waitUntil(handlePackFetch(event.registration));
});
