import { describe, expect, it } from "vitest";

import {
  OFFLINE_EXPIRED_HTML,
  OFFLINE_FALLBACK_HTML,
  OFFLINE_FRESHNESS_POLICY,
  FRESHNESS_STATE,
  buildFreshnessBannerHtml,
  buildOfflineNavigationResponse,
  classifyCachedFreshness,
  injectBanner,
  injectOfflineBanner,
  planCacheAdmission,
} from "../../public/offline-cache-helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2024-06-15T12:00:00.000Z");

const html = "<!doctype html><html><head></head><body><h1>Card</h1></body></html>";

describe("classifyCachedFreshness (issue #161 policy)", () => {
  it("treats a snapshot within FRESH_WINDOW as fresh", () => {
    const cachedAt = new Date(NOW - 3 * DAY).toISOString();
    expect(classifyCachedFreshness(cachedAt, NOW).state).toBe(FRESHNESS_STATE.FRESH);
  });

  it("treats a snapshot in the 7d–30d band as stale", () => {
    const cachedAt = new Date(NOW - 14 * DAY).toISOString();
    const { state, ageMs } = classifyCachedFreshness(cachedAt, NOW);
    expect(state).toBe(FRESHNESS_STATE.STALE);
    expect(ageMs).toBeGreaterThan(OFFLINE_FRESHNESS_POLICY.FRESH_WINDOW_MS);
  });

  it("treats a snapshot older than HARD_EXPIRY as expired", () => {
    const cachedAt = new Date(NOW - 90 * DAY).toISOString();
    expect(classifyCachedFreshness(cachedAt, NOW).state).toBe(FRESHNESS_STATE.EXPIRED);
  });

  it("refuses an unparseable timestamp (fail-closed, not fail-open)", () => {
    expect(classifyCachedFreshness("not-a-date", NOW).state).toBe(
      FRESHNESS_STATE.EXPIRED,
    );
  });

  it("refuses a future timestamp (clock skew) instead of trusting it", () => {
    const cachedAt = new Date(NOW + DAY).toISOString();
    expect(classifyCachedFreshness(cachedAt, NOW).state).toBe(FRESHNESS_STATE.EXPIRED);
  });
});

describe("buildFreshnessBannerHtml", () => {
  it("keeps the amber 'Showing cached data as of' copy for fresh state", () => {
    const out = buildFreshnessBannerHtml("2024-06-14T12:00:00.000Z", FRESHNESS_STATE.FRESH);
    expect(out).toContain("Showing cached data as of");
  });

  it("escalates to a red, explicit warning for the stale state", () => {
    const out = buildFreshnessBannerHtml("2024-06-01T12:00:00.000Z", FRESHNESS_STATE.STALE);
    expect(out).toContain("over a week old");
    expect(out).toContain("may have changed");
    expect(out).toContain("#ef4444");
  });
});

describe("injectBanner", () => {
  it("inserts a banner as the first child of <body>", () => {
    const out = injectBanner(html, "<b>BANNER</b>");
    expect(out.indexOf("<b>BANNER</b>")).toBeGreaterThan(out.indexOf("<body"));
    expect(out.indexOf("<b>BANNER</b>")).toBeLessThan(out.indexOf("<h1>Card</h1>"));
  });

  it("returns just the banner for empty input", () => {
    expect(injectBanner("", "<b>BANNER</b>")).toBe("<b>BANNER</b>");
  });

  it("is backwards-compatible with injectOfflineBanner", () => {
    const a = injectOfflineBanner(html, "2024-06-14T12:00:00.000Z");
    expect(a).toContain('class="lafiya-offline-banner"');
  });
});

describe("buildOfflineNavigationResponse freshness branches", () => {
  it("serves a fresh cached card with the normal banner", () => {
    const cachedAt = new Date(NOW - 2 * DAY).toISOString();
    const res = buildOfflineNavigationResponse({ cachedHtml: html, cachedAt, now: NOW });
    expect(res.fromCache).toBe(true);
    expect(res.freshness).toBe(FRESHNESS_STATE.FRESH);
    expect(res.html).toContain("Showing cached data as of");
    expect(res.html).toContain("<h1>Card</h1>");
  });

  it("serves a stale cached card with the escalated warning but still shows data", () => {
    const cachedAt = new Date(NOW - 20 * DAY).toISOString();
    const res = buildOfflineNavigationResponse({ cachedHtml: html, cachedAt, now: NOW });
    expect(res.fromCache).toBe(true);
    expect(res.freshness).toBe(FRESHNESS_STATE.STALE);
    expect(res.html).toContain("over a week old");
    expect(res.html).toContain("<h1>Card</h1>");
  });

  it("REFUSES an expired cached card and returns the distinct 'too old to trust' state", () => {
    const cachedAt = new Date(NOW - 120 * DAY).toISOString();
    const res = buildOfflineNavigationResponse({ cachedHtml: html, cachedAt, now: NOW });
    expect(res.fromCache).toBe(false);
    expect(res.freshness).toBe(FRESHNESS_STATE.EXPIRED);
    expect(res.html).toBe(OFFLINE_EXPIRED_HTML);
    expect(res.html).not.toContain("<h1>Card</h1>");
  });

  it("returns the never-visited fallback when there is no cached HTML", () => {
    const res = buildOfflineNavigationResponse({ cachedHtml: "", cachedAt: null, now: NOW });
    expect(res.fromCache).toBe(false);
    expect(res.html).toBe(OFFLINE_FALLBACK_HTML);
  });
});

describe("freshness policy integrates with existing cache helpers", () => {
  it("does not change eviction accounting — planCacheAdmission still admits within budget", () => {
    const plan = planCacheAdmission({
      entries: [{ key: "a", size: 1000, lastAccessed: 1 }],
      incomingSize: 2000,
      maxEntries: 60,
      maxBytes: 3 * 1024 * 1024,
    });
    expect(plan.admit).toBe(true);
    expect(plan.toEvict).toEqual([]);
  });

  it("still refuses an oversized entry (unrelated to age)", () => {
    const plan = planCacheAdmission({
      entries: [],
      incomingSize: 4 * 1024 * 1024,
      maxEntries: 60,
      maxBytes: 3 * 1024 * 1024,
    });
    expect(plan.admit).toBe(false);
  });
});
