import { describe, expect, it } from "vitest";

import {
  BODY_SIZE_HEADER,
  CACHED_AT_HEADER,
  LAST_ACCESSED_HEADER,
  OFFLINE_FALLBACK_HTML,
  buildOfflineNavigationResponse,
  enforceCacheBudget,
  planCacheAdmission,
  readEntryMeta,
  withEntryMetaHeaders,
} from "../../public/offline-cache-helpers.js";

const ORIGIN = "https://lafiya.example";

function cardUrl(id: string) {
  return `${ORIGIN}/card/${id}`;
}

function makeCachedResponse({
  body = "<html><body>card</body></html>",
  cachedAt = "2024-01-01T00:00:00.000Z",
  lastAccessed,
  size,
}: {
  body?: string;
  cachedAt?: string;
  lastAccessed: number;
  size?: number;
}) {
  const headers = withEntryMetaHeaders(new Headers({ "Content-Type": "text/html" }), {
    cachedAt,
    lastAccessed,
    size: size ?? body.length,
  });
  return new Response(body, { status: 200, headers });
}

/**
 * A minimal in-memory stand-in for the Cache Storage `Cache` interface,
 * keyed by request URL (like the real thing's default match behavior).
 * Lets the eviction/accounting logic be exercised without jsdom needing to
 * implement Cache Storage (it doesn't).
 */
function createFakeCache() {
  const store = new Map<string, { request: Request; response: Response }>();
  return {
    store,
    async keys() {
      return Array.from(store.values()).map((entry) => entry.request);
    },
    async match(request: Request | string) {
      const url = typeof request === "string" ? request : request.url;
      const entry = store.get(url);
      return entry ? entry.response.clone() : undefined;
    },
    async put(request: Request | string, response: Response) {
      const url = typeof request === "string" ? request : request.url;
      const req = typeof request === "string" ? new Request(request) : request;
      store.set(url, { request: req, response: response.clone() });
    },
    async delete(request: Request | string) {
      const url = typeof request === "string" ? request : request.url;
      return store.delete(url);
    },
  };
}

describe("planCacheAdmission", () => {
  it("evicts the least-recently-ACCESSED entry, not the least-recently-written one", () => {
    // b was cached after a, so a is "older" by write time. But a has since
    // been re-read (lastAccessed bumped ahead of b) — a must survive.
    const entries = [
      { key: "a", size: 10, lastAccessed: 500 },
      { key: "b", size: 10, lastAccessed: 200 },
    ];
    const plan = planCacheAdmission({
      entries,
      incomingSize: 10,
      maxEntries: 2,
      maxBytes: 1000,
    });
    expect(plan.admit).toBe(true);
    expect(plan.toEvict).toEqual(["b"]);
  });

  it("enforces the byte budget even when under the entry-count cap", () => {
    const entries = [
      { key: "a", size: 100, lastAccessed: 100 },
      { key: "b", size: 100, lastAccessed: 200 },
    ];
    const plan = planCacheAdmission({
      entries,
      incomingSize: 100,
      maxEntries: 10, // well under the count cap
      maxBytes: 250, // but three 100-byte entries don't fit
    });
    expect(plan.admit).toBe(true);
    expect(plan.toEvict).toEqual(["a"]); // oldest-accessed goes first
  });

  it("never selects a protected (in-flight) key as an eviction victim", () => {
    const entries = [
      { key: "a", size: 10, lastAccessed: 1 }, // oldest, but protected
      { key: "b", size: 10, lastAccessed: 2 },
    ];
    const plan = planCacheAdmission({
      entries,
      incomingSize: 10,
      maxEntries: 2,
      maxBytes: 1000,
      protectedKeys: ["a"],
    });
    expect(plan.admit).toBe(true);
    expect(plan.toEvict).toEqual(["b"]);
  });

  it("refuses admission rather than evict a protected key it can't do without", () => {
    const entries = [{ key: "a", size: 10, lastAccessed: 1 }];
    const plan = planCacheAdmission({
      entries,
      incomingSize: 10,
      maxEntries: 1,
      maxBytes: 1000,
      protectedKeys: ["a"],
    });
    expect(plan.admit).toBe(false);
    expect(plan.toEvict).toEqual([]);
  });

  it("refuses an entry that alone exceeds the byte budget, without evicting anything", () => {
    const entries = [
      { key: "a", size: 10, lastAccessed: 1 },
      { key: "b", size: 10, lastAccessed: 2 },
    ];
    const plan = planCacheAdmission({
      entries,
      incomingSize: 5000,
      maxEntries: 10,
      maxBytes: 1000,
    });
    expect(plan.admit).toBe(false);
    expect(plan.toEvict).toEqual([]);
  });
});

describe("enforceCacheBudget (against a fake Cache Storage cache)", () => {
  it("evicts by last-accessed order, surviving a 'refresh then add' sequence", async () => {
    const cache = createFakeCache();
    await cache.put(cardUrl("a"), makeCachedResponse({ lastAccessed: 100 }));
    await cache.put(cardUrl("b"), makeCachedResponse({ lastAccessed: 200 }));

    // Re-read "a" (a responder re-checking a card daily) — bump its
    // last-accessed ahead of "b" even though "b" was cached more recently.
    const aResponse = await cache.match(cardUrl("a"));
    await cache.put(
      cardUrl("a"),
      new Response(await aResponse!.clone().arrayBuffer(), {
        headers: withEntryMetaHeaders(aResponse!.headers, {
          cachedAt: "2024-01-01T00:00:00.000Z",
          lastAccessed: 900,
          size: readEntryMeta(aResponse!.headers).size,
        }),
      }),
    );

    const { admit, evicted } = await enforceCacheBudget({
      cache,
      incomingRequest: cardUrl("c"),
      incomingSize: 10,
      maxEntries: 2,
      maxBytes: 10_000,
    });

    expect(admit).toBe(true);
    expect(evicted).toEqual([cardUrl("b")]);
    expect(await cache.match(cardUrl("a"))).toBeDefined();
    expect(await cache.match(cardUrl("b"))).toBeUndefined();
  });

  it("evicts to stay within the byte budget even with very large cached entries", async () => {
    const cache = createFakeCache();
    await cache.put(
      cardUrl("big-1"),
      makeCachedResponse({ lastAccessed: 100, size: 1_000_000 }),
    );
    await cache.put(
      cardUrl("big-2"),
      makeCachedResponse({ lastAccessed: 200, size: 1_000_000 }),
    );

    const { admit, evicted } = await enforceCacheBudget({
      cache,
      incomingRequest: cardUrl("big-3"),
      incomingSize: 1_200_000,
      maxEntries: 60, // count cap not remotely hit
      maxBytes: 3 * 1024 * 1024, // but all three ~1-1.2MB entries don't fit in 3MB
    });

    expect(admit).toBe(true);
    expect(evicted).toEqual([cardUrl("big-1")]);
  });

  it("never evicts the key of the in-flight request currently being served", async () => {
    const cache = createFakeCache();
    await cache.put(cardUrl("in-flight"), makeCachedResponse({ lastAccessed: 1 }));
    await cache.put(cardUrl("other"), makeCachedResponse({ lastAccessed: 2 }));

    const { evicted } = await enforceCacheBudget({
      cache,
      incomingRequest: cardUrl("new"),
      incomingSize: 10,
      maxEntries: 2,
      maxBytes: 10_000,
      protectedKeys: [cardUrl("in-flight")],
    });

    expect(evicted).not.toContain(cardUrl("in-flight"));
    expect(await cache.match(cardUrl("in-flight"))).toBeDefined();
  });

  it("leaves the cache in a consistent, recoverable state if terminated mid-eviction", async () => {
    const cache = createFakeCache();
    await cache.put(cardUrl("a"), makeCachedResponse({ lastAccessed: 1 }));
    await cache.put(cardUrl("b"), makeCachedResponse({ lastAccessed: 2 }));
    await cache.put(cardUrl("c"), makeCachedResponse({ lastAccessed: 3 }));

    let deleteCalls = 0;
    const realDelete = cache.delete.bind(cache);
    const flakyCache = {
      ...cache,
      delete: async (request: Request | string) => {
        deleteCalls += 1;
        if (deleteCalls === 2) {
          throw new Error("simulated service worker termination");
        }
        return realDelete(request);
      },
    };

    // Needs two evictions (a and b) to admit "d" under maxEntries: 1.
    await expect(
      enforceCacheBudget({
        cache: flakyCache,
        incomingRequest: cardUrl("d"),
        incomingSize: 10,
        maxEntries: 1,
        maxBytes: 10_000,
      }),
    ).rejects.toThrow("simulated service worker termination");

    // The first delete committed before the throw; nothing partial or
    // corrupted — "a" is cleanly gone, "b" and "c" are cleanly intact.
    expect(await cache.match(cardUrl("a"))).toBeUndefined();
    const bStillThere = await cache.match(cardUrl("b"));
    expect(bStillThere).toBeDefined();
    expect(readEntryMeta(bStillThere!.headers).lastAccessed).toBe(2);
    const cStillThere = await cache.match(cardUrl("c"));
    expect(cStillThere).toBeDefined();

    // A subsequent (retried) invocation converges normally — no leftover
    // corrupt state blocks it.
    const retry = await enforceCacheBudget({
      cache,
      incomingRequest: cardUrl("d"),
      incomingSize: 10,
      maxEntries: 1,
      maxBytes: 10_000,
    });
    expect(retry.admit).toBe(true);
  });
});

describe("buildOfflineNavigationResponse", () => {
  it("serves the honest fallback for a card that was evicted (indistinguishable from never-visited)", async () => {
    const cache = createFakeCache();
    await cache.put(cardUrl("keep"), makeCachedResponse({ lastAccessed: 200 }));
    await cache.put(cardUrl("evict-me"), makeCachedResponse({ lastAccessed: 100 }));

    await enforceCacheBudget({
      cache,
      incomingRequest: cardUrl("new"),
      incomingSize: 10,
      maxEntries: 2,
      maxBytes: 10_000,
    });

    const evictedResponse = await cache.match(cardUrl("evict-me"));
    expect(evictedResponse).toBeUndefined();

    const { html, fromCache } = buildOfflineNavigationResponse({
      cachedHtml: evictedResponse ? await evictedResponse.text() : undefined,
      cachedAt: undefined,
    });

    expect(fromCache).toBe(false);
    expect(html).toBe(OFFLINE_FALLBACK_HTML);
    expect(html).toContain("No cached card available");
    expect(html).not.toContain("Showing cached data as of");
  });

  it("serves the cached copy with a banner for a surviving entry, uncorrupted", async () => {
    const cache = createFakeCache();
    const body = "<html><body><h1>Patient Card</h1></body></html>";
    await cache.put(
      cardUrl("keep"),
      makeCachedResponse({
        body,
        lastAccessed: 200,
        cachedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );

    const cached = await cache.match(cardUrl("keep"));
    const cachedAt = cached!.headers.get(CACHED_AT_HEADER);
    const { html, fromCache } = buildOfflineNavigationResponse({
      cachedHtml: await cached!.text(),
      cachedAt,
    });

    expect(fromCache).toBe(true);
    expect(html).toContain("Showing cached data as of");
    expect(html).toContain("<h1>Patient Card</h1>");
  });
});

describe("readEntryMeta / withEntryMetaHeaders", () => {
  it("round-trips last-accessed and size through headers", () => {
    const headers = withEntryMetaHeaders(new Headers(), {
      cachedAt: "2024-01-01T00:00:00.000Z",
      lastAccessed: 12345,
      size: 6789,
    });
    expect(readEntryMeta(headers)).toEqual({ lastAccessed: 12345, size: 6789 });
  });

  it("defaults missing/unparseable metadata to 0 rather than throwing", () => {
    expect(readEntryMeta(new Headers())).toEqual({ lastAccessed: 0, size: 0 });
    expect(
      readEntryMeta(
        new Headers({ [LAST_ACCESSED_HEADER]: "nope", [BODY_SIZE_HEADER]: "nope" }),
      ),
    ).toEqual({ lastAccessed: 0, size: 0 });
  });
});
