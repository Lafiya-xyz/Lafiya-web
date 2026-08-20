# Define safe offline freshness & revocation policy for emergency cards

Resolves the spike in **Lafiya-xyz/Lafiya-web#161** (GrantFox OSS / Third Campaign).

## Summary

The offline service worker cached visited `/card/*` pages but had **no product
policy** for how old a cached card may be before it is unsafe to display, how
revoked/rotated cards or unreachable networks should behave, or what
user-facing copy/failure states a responder sees. This PR delivers the spike's
required analysis **and** a tested prototype of the recommended warning/expiry
behaviour.

## What changed

- **`public/offline-cache-helpers.js`**
  - Added `OFFLINE_FRESHNESS_POLICY` (`FRESH_WINDOW_MS = 7d`, `HARD_EXPIRY_MS = 30d`) and `FRESHNESS_STATE`.
  - Added pure, timezone-safe, **fail-closed** `classifyCachedFreshness(cachedAtIso, nowMs)` — unparseable or future timestamps are treated as *expired*, never served.
  - Added `buildFreshnessBannerHtml(isoString, state)` — amber banner for fresh, **red escalated** warning for stale ("over a week old … details may have changed").
  - Refactored banner insertion into `injectBanner` so `injectOfflineBanner` and the freshness path share identical semantics (backwards compatible).
  - `buildOfflineNavigationResponse({ cachedHtml, cachedAt, now })` now routes through the classifier:
    - **fresh** → normal "cached as of" banner
    - **stale** (7–30d) → red warning, card still served (offline usefulness)
    - **expired** (>30d) → **refused**; serves a distinct "Cached card too old to trust" empty state instead of a silently-stale medical snapshot
    - no HTML → unchanged "never visited" fallback
  - Added `OFFLINE_EXPIRED_HTML` (distinct from the never-visited fallback so a responder understands *why* nothing is shown).
  - `public/sw.js` already calls this helper on the offline path; the new `now` default keeps behaviour correct with no further changes.
- **`tests/unit/offline-freshness.test.ts`** (new, 16 tests) exercises every freshness branch, fail-closed behaviour, banner insertion, and integration with the pre-existing `planCacheAdmission` eviction helper.
- **`issues/issue-11-offline-freshness-policy.md`** (new) — the full spike deliverable: threat/safety analysis, explicit age thresholds + rationale, user-facing copy/failure states, revocation/rotation/unreachable-network handling, and a follow-up implementation specification.

## Key design decisions

- **Two freshness axes kept distinct** (issue acceptance criterion): *cached
  freshness* (service-worker `x-lafiya-cached-at`) vs. *on-chain/attestation
  freshness* (must be re-checked online). The offline cache only reasons about
  the former.
- **Fail-closed on age:** bias toward refusing a possibly-dangerous snapshot
  past 30 days rather than risking a clinical false negative.
- **Offline guarantee preserved:** no network call is added to the always-offline happy path.
- **Decoupled but compatible** with card-ID rotation/revocation (issue #6): this
  policy bounds the worst case to ≤30 days even if an online revocation beacon
  never fires.

## Test plan

```bash
npm test
# or specifically:
npx vitest run tests/unit/offline-cache-helpers.test.ts tests/unit/offline-freshness.test.ts
```

All 24 tests pass (8 pre-existing + 16 new).

## Acceptance criteria (from #161)

- [x] Analysis distinguishes cached freshness from on-chain attestation freshness.
- [x] Revoked/rotated cards and unreachable-network behavior are addressed.
- [x] Recommendation defines user-facing copy and failure states.
- [x] Prototype is tested against the existing service-worker cache helpers.

Closes #161.
