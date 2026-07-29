## Title
Design and implement a bounded, self-managing eviction policy for the offline emergency-card cache so it cannot grow without limit on low-storage devices

## Difficulty
10/10 — Expert. Estimated effort: 3–5 days for a senior engineer.

## Context
Per the README's Offline Support section, `app/public/sw.js` caches the rendered HTML of every distinct `/card/[id]` a responder's device has ever visited, indefinitely, in the `lafiya-cards-v1` Cache Storage bucket. This is explicitly the product's core resilience story: "a responder scanning a QR in a dead zone" must get a readable card. The intended users — CHWs and responders on shared or low-end Android devices in Nigeria, per the README's problem statement — are exactly the population most likely to (a) scan many different patients' cards over the lifetime of one device (a clinic tablet, a CHW's personal phone used across dozens of registrations) and (b) be running devices with constrained flash storage where the browser's own storage-eviction heuristics (e.g., Chrome's origin storage pressure eviction) are a real, not theoretical, constraint.

`app/public/sw.js` has no eviction logic whatsoever: `handleCardNavigation` (`app/public/sw.js:63-104`) unconditionally `cache.put`s every successful card render, forever, with no cap on entry count, no cap on total bytes, and no time-based expiry beyond the `x-lafiya-cached-at` header used purely for display (the "Showing cached data as of..." banner), never for eviction. The `activate` handler (`app/public/sw.js:29-41`) only clears caches from a *previous cache-name version*, not stale entries within the current one. Left to run, this cache grows monotonically for the entire operational lifetime of the app on a given device — directly undermining the very reliability goal the offline feature exists to serve, since an uncontrolled cache can itself trigger the browser evicting the *entire* origin's storage (including the styles cache and potentially other app data) once the device hits its storage quota, rather than gracefully dropping old entries.

## Problem statement
Implement a bounded cache-management policy for `lafiya-cards-v1` (and, if you determine it should share the policy, `lafiya-styles-v1`) that enforces both a maximum entry count and a maximum total-byte budget, evicting the least-valuable entries first, without ever evicting or corrupting the entry a user is actively viewing, and without silently violating the existing "never serve a stale 404" and "never cache a card that was never actually visited" invariants documented in the README and enforced by the current `handleCardNavigation` logic.

Because the Cache Storage API provides no built-in TTL, LRU, or size-accounting primitives, you must build the bookkeeping yourself — Cache Storage keys/responses give you no cheap way to enumerate "least recently used" without maintaining your own index, and `Response` objects don't expose a reliable byte-size without reading the body.

## Current behavior
- `app/public/sw.js:63-104` (`handleCardNavigation`) — `cache.put` on every successful navigation, no count/size check, no eviction call anywhere in the file.
- `app/public/sw.js:18` — `CARD_CACHE` name is versioned (`lafiya-cards-v1`) only for wholesale cache-busting on a deploy (via `activate`'s cleanup of non-matching cache names), not for bounding growth within a version.
- `app/public/offline-cache-helpers.js` (per `tests/unit/offline-cache-helpers.test.ts`) currently only contains pure banner-injection/formatting helpers — no cache-accounting logic exists there or anywhere else in the repo.
- No test in the repository exercises cache size or entry-count behavior; `tests/unit/offline-cache-helpers.test.ts` only covers the banner HTML injection.

## Required behavior
- The card cache must never exceed a configurable maximum entry count and a configurable maximum total-byte budget (pick concrete, justified defaults appropriate to a low-end Android device and document your reasoning — e.g., in terms of the `docs/perf-budget.md` per-card size budget already established for this route).
- When the budget would be exceeded by a new entry, the least-recently-*accessed* (not least-recently-*written*) entry must be evicted first — a card a responder re-checks daily should outlive one viewed once and never again, even if the once-viewed one was cached more recently.
- Eviction must never remove the entry currently being served to an in-flight request, and must never leave the cache in a state where a previously-"200 OK, now evicted" card silently becomes indistinguishable from "never visited" in a way that regresses the existing offline-fallback UX (the existing honest "No cached card available" state is the correct outcome for an evicted card — this must be verified, not assumed).
- The mechanism must be correct under the service worker's actual execution model: handlers can be terminated by the browser between `await` points at any time, so bookkeeping (e.g., an access-time index) must be persisted transactionally enough that a mid-update termination cannot corrupt the index or leak storage.

## Constraints
- No new runtime dependency — implement this using only Cache Storage, and IndexedDB if you need durable structured bookkeeping (both are available in the service-worker global scope without a bundler dependency).
- Must not regress `tests/unit/offline-cache-helpers.test.ts` or the documented manual offline test protocol in the README (the "warm cache → go offline → see banner", "never-visited card → honest fallback", "404 never cached" behaviors must all still hold).
- Must not require a network round-trip to enforce eviction (the whole point of this cache is functioning without one).
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] A unit-testable module (extending or sitting alongside `app/public/offline-cache-helpers.js`) implementing the eviction/accounting policy, independent of the live `caches`/`indexedDB` globals where feasible (inject them for testability, matching this file's existing pure-function style).
- [ ] A test proving that caching more than the configured max entry count evicts the least-recently-accessed entry, not the least-recently-written one (requires a test that reads an old entry to "refresh" it, then adds new entries, and asserts the refreshed one survives).
- [ ] A test proving the total-byte budget is enforced even when entry count is under the count cap (e.g., a few very large cached photos should still trigger eviction).
- [ ] A test proving an in-flight/currently-served entry is never evicted mid-request.
- [ ] A test proving that after eviction, requesting the evicted card offline produces the existing honest "No cached card available" fallback, not a crash or a corrupted partial response.
- [ ] A test simulating an abrupt termination mid-bookkeeping-update (e.g., a rejected promise partway through the index update) and proving the cache/index is left in a consistent, recoverable state on the next invocation.
- [ ] The manual offline test protocol in the README continues to pass unmodified when exercised in a real browser.

## Out of scope
- The card-ID-rotation revocation problem (separate issue in this batch) — this issue is about bounding *normal* cache growth, not about forcibly purging a specific entry on patient-triggered rotation.
- Any change to the server-side ISR/`unstable_cache` layers (separate issue in this batch).
- A PWA manifest or "add to home screen" flow (mentioned in the README as a companion piece, but a separate, unbuilt feature this issue does not need to touch).

## Hints and references
- Chrome's Storage documentation on origin storage pressure and eviction (`https://developer.chrome.com/docs/apps/offline_storage` and the Storage Manager API `navigator.storage.estimate()`), for sizing your budget defaults against realistic low-end-device quotas.
- Classic LRU cache implementation patterns (doubly-linked-list + hashmap, or a simpler access-timestamp-sorted index acceptable given Cache Storage's own access patterns) — pick one appropriate to the service worker's execution constraints and justify it.
- The `docs/perf-budget.md` file's existing per-card-page size budget (≤110 kB with photo) as a starting point for reasoning about a sane per-device total cache budget.
