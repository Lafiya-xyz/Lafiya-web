## Title
Make card-ID rotation an actual revocation mechanism by propagating it through every caching layer (Next.js ISR/data cache and the offline service worker), instead of only updating the database row

## Difficulty
10/10 — Expert. Estimated effort: 4–6 days for a senior engineer.

## Context
`regenerateCardId` (`app/(auth)/profile/actions.ts:101-128`) exists specifically so a patient can invalidate a previously-shared or leaked QR code/URL: it replaces `profiles.card_public_id` with a fresh random UUID, so the old identifier no longer resolves via `get_emergency_card`. This is the product's only access-revocation primitive — there is no authentication, expiry, or per-request check on `/card/[id]` (it is deliberately public and login-free, per the README's design), so "make the old link stop working" is the *entire* security model for a patient who wants to revoke a specific copy of their card.

That model only actually holds at the database layer. The public card page is not `force-dynamic` — per `docs/card-caching-strategy.md` and `app/(public)/card/[id]/page.tsx:17` (`export const revalidate = 60`), it is ISR-cached with a 60-second TTL specifically so repeated views don't hit the database. `upsertProfile` explicitly calls `revalidatePath` for the *current* card path after a save (`app/(auth)/profile/actions.ts:239-242`), proving the team is already aware that this caching layer needs explicit invalidation on data changes — but `regenerateCardId` (`app/(auth)/profile/actions.ts:101-128`) calls only `revalidatePath("/profile")`, never anything for `/card/[oldId]`. Anyone who had previously loaded the *old* card URL within the last 60 seconds before rotation can therefore continue to receive a cached, fully live-looking render of it for up to a minute after the patient believed they'd revoked it — a narrow gap on its own, but one that establishes the pattern the rest of this issue is actually about.

The much larger gap is the offline service worker. Per the README's Offline Support section and `app/public/sw.js`, the whole point of this cache is that a previously-visited `/card/[id]` renders **without any network request at all** when offline — `handleCardNavigation` (`app/public/sw.js:63-104`) serves straight from `Cache Storage` on a fetch failure, with no mechanism to check "has this ID been revoked?" because that check would itself require a network round-trip, defeating the offline guarantee. This means: **if a responder's device ever cached the old card while online, rotating the ID does nothing to that device's copy, ever** — there is no expiry, no revocation list, no cache-busting scheme tied to rotation, and (per the related unbounded-cache-growth issue in this batch) no natural eviction that would incidentally clear it either. A patient who rotates their card ID specifically because a device or printed QR leaked has no way to actually stop that specific leaked copy from continuing to work offline, indefinitely, on any device that already cached it. The "revocation" feature is real only for a narrow class of viewers (online, first-time, past the TTL) and illusory for the exact threat model it exists to address (a responder's device that already has the old page cached, potentially offline).

## Problem statement
Design and implement a revocation-propagation mechanism such that, after a patient rotates their `card_public_id`, the old identifier stops rendering *live* patient data within a bounded, documented time window — across the ISR/data cache layer (fixable server-side) **and** across any device that had already cached the old page in its offline service-worker cache (the hard part, since that device may never make another network request to that URL again to learn about the rotation). You must produce a concrete answer to: how does a device that cached `/card/{oldId}` and then goes permanently offline ever learn that ID has been revoked, given the offline cache's entire purpose is to avoid needing the network?

If, after genuine design work, you conclude that fully solving the "already-offline, already-cached" case is not achievable without breaking the offline guarantee, you must still: (a) fully close the server-side ISR gap (the actually-fixable, in-scope part), (b) implement a best-effort propagation for any device that *does* come back online even briefly (e.g., on next successful navigation to any `/card/*` URL, or via a periodic background sync opportunity), and (c) make the residual risk explicit and testable rather than silently accepted — e.g., a documented, enforced maximum "safe" staleness window that the product can honestly state to patients ("revoking a card takes effect for anyone who was previously offline within N days of your rotation, the next time their device reconnects").

## Current behavior
- `app/(auth)/profile/actions.ts:101-128` (`regenerateCardId`) — updates `card_public_id`, calls `revalidatePath("/profile")` only.
- `app/(public)/card/[id]/page.tsx:17` — `revalidate = 60`, no rotation-aware invalidation path exists.
- `app/public/sw.js:63-104` — serves cached HTML on any fetch failure with zero revocation-awareness; the cache entry for the old ID persists until manually cleared or (per the separate eviction issue) naturally evicted by an unrelated LRU/size policy, which provides no timing guarantee tied to rotation.
- No mechanism anywhere in the repo (service worker, page, API route) currently tells a client "the ID you have cached is revoked."

## Required behavior
- Rotating a card ID must, within one render cycle, guarantee the old ID's server-rendered/ISR-cached page no longer serves live patient data on any subsequent online request (a `notFound()` or equivalent is correct, since the DB row for that ID genuinely no longer exists — the fix is ensuring the *cache* reflects that immediately rather than up to 60 seconds later).
- A documented, implemented mechanism by which a device holding a stale offline-cached copy of a rotated card learns about the rotation the next time it has *any* network connectivity, even if that connectivity isn't specifically a fresh visit to that exact card URL (e.g., a lightweight revocation-check request the service worker can perform opportunistically).
- The mechanism must not defeat the core offline guarantee: a responder who is offline and has a legitimately still-valid cached card must continue to see it instantly, with no added latency or network dependency on the happy path.
- A clear, tested answer for what a revoked card shows when a device does learn about the revocation while still offline-for-that-request (e.g., does it fall back to the "No cached card available" honest-empty-state already used for never-visited cards, and is that distinguishable from "this ID doesn't exist" vs. "this ID was intentionally revoked" in a way that doesn't leak information to an attacker probing IDs)?

## Constraints
- Must not require the patient or responder to be authenticated to check revocation status (the entire product's premise is login-free responder access).
- Must not introduce a network dependency on the always-offline happy path for a still-valid cached card.
- Must not conflict with or duplicate the unbounded-cache-growth eviction policy from the separate issue in this batch — if your design relies on the service worker checking revocation status, keep that logic decoupled from (but compatible with) whatever eviction bookkeeping that issue introduces; do not make either issue depend on the other being solved first.
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] `regenerateCardId` triggers immediate invalidation of the old card's ISR-cached entry, proven by a test that renders the old path from cache, rotates, and asserts the very next request (within the old 60s window) no longer returns cached patient data.
- [ ] A test proving a rotated ID's page returns a `notFound()`-equivalent response after rotation, indistinguishable in timing/response shape from an ID that never existed (no oracle for "this ID used to be valid").
- [ ] A working, tested service-worker mechanism that detects revocation on some real, defined trigger (documented explicitly) without requiring the responder to specifically revisit the revoked URL, and updates or purges the stale cache entry as a result.
- [ ] A test proving the offline happy path (a still-valid cached card, viewed with no network) has no added latency or network call introduced by the new mechanism.
- [ ] A written, explicit statement in the PR of the residual "already cached, never reconnects" risk window, with reasoning for why it's an acceptable, honestly-documented tradeoff rather than a silently-accepted gap.
- [ ] `npm test` and the manual offline test protocol in the README both pass.

## Out of scope
- The general unbounded service-worker cache growth/eviction-policy problem (separate issue in this batch) — do not attempt to solve both in one PR; keep the mechanisms independently mergeable.
- The record-hash/attestation revocation problem (a different revocation concept entirely — that one is about a health worker revoking their *verification*, this one is about a patient revoking *access to their card's URL*).
- Any change to how `card_public_id` itself is generated (still a random UUID; this issue is about propagating its rotation, not changing its shape).

## Hints and references
- Service Worker `sync`/periodic background sync APIs (`https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API`) as one candidate mechanism for opportunistic revocation checks, weighed against browser support constraints on the low-end Android devices this product targets.
- Next.js `revalidatePath`/`revalidateTag` semantics for on-demand ISR invalidation (already used elsewhere in this codebase, e.g. `upsertProfile`) as the mechanism for the server-side half of this fix.
- Cache-Control / stale-while-revalidate design patterns for reasoning about the "bounded staleness window" tradeoff you must document.
