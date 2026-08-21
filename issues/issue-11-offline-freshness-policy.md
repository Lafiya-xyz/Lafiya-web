# [Spike] Offline freshness & revocation policy for emergency cards

**Issue:** #161 · **Campaign:** GrantFox OSS / Third Campaign
**Author:** Phantomcall · **Status:** prototype + analysis (implementation follow-up specified)

This document is the deliverable for the spike in Lafiya-xyz/Lafiya-web#161. It
contains the threat/safety analysis, the concrete policy recommendation with
explicit age thresholds, the prototype warning/expiry behaviour that is now
tested against the existing service-worker cache helpers, and a follow-up
implementation specification.

---

## 1. Problem framing

`public/sw.js` caches visited `/card/*` HTML after a real navigation and, when
the network is unavailable, serves the last cached copy with a "Showing cached
data as of …" banner. The cache is bounded (entry count + bytes, LRU eviction)
but has **no product policy** for:

- a maximum *age* a cached card may be before it is unsafe to display,
- how high-risk field changes (allergies, medications) should be treated
  differently from low-risk ones,
- what "revoked" or "rotated" means for an already-offline device,
- what copy/failure states a responder should see.

The risk is clinical, not merely cosmetic: a responder who trusts a stale
allergy list or a revoked card in a dead zone can make a wrong decision about
treatment.

---

## 2. Two independent freshness axes (must be kept distinct)

A frequent mistake is to treat "the page loaded recently" as "the medical data
is current". They are different things:

| Axis | What it measures | Stamped by | Checked |
|------|-----------------|------------|---------|
| **Cached freshness** | How long ago *this HTML snapshot* was stored by the service worker (`x-lafiya-cached-at`). | Service worker, client-side only. | Offline (this spike). |
| **On-chain / attestation freshness** | How recently the patient's verification/attestation was (re)issued on-chain. | The card page, from the attestation record. | Must be re-checked **online**. |

A card can be **cache-fresh** (served from a snapshot taken yesterday) while
**attestation-stale** (verification expired last month), or vice-versa. The
offline cache only ever reasons about **cached freshness**. Attestation
freshness cannot be validated offline (it requires the chain) and is therefore
out of scope for the offline banner beyond surfacing the cached attestation
date when present. Any future work that wants to refuse an attestation-stale
card offline must do so via an online revocation/status beacon (see §5), never
by inferring it from cache age.

**This distinction is the first acceptance criterion of the issue.**

---

## 3. Threat / safety analysis

| # | Threat | Offline-relevant? | Mitigation in this policy |
|---|--------|-------------------|---------------------------|
| T1 | Responder trusts a card whose allergy/medication data changed weeks ago. | Yes | Age-based escalation + hard expiry (§4). |
| T2 | Patient rotates card ID to revoke a leaked link; a device that already cached the *old* URL keeps serving it offline forever. | Yes (the hard case) | Cache-age hard expiry bounds the window; full rotation propagation is a server+online fix (§5, separate issue #6). |
| T3 | Responder believes a card is *current* when it is merely *cached*. | Yes | Always-on banner with explicit timestamp; colour escalates with age. |
| T4 | Clock skew makes a card look "fresh" or "future". | Yes | Future/unparseable timestamps fail **closed** → treated as expired, never served. |
| T5 | Over-aggressive expiry hides a *still-valid* card during a routine outage. | Yes (availability) | 7-day fresh window + 30-day serve-anyway-stale band balances safety vs. usefulness. |
| T6 | Privacy leak: serving a cached card reveals a patient was visited. | Partially | Offline cache is per-device, not shared; no network call on the happy path (preserves the offline guarantee). |

**False-positive / false-negative trade-off:** expiring too early → responder
loses a legitimately-useful card (false positive on "stale"); expiring too
late → responder trusts dangerous data (false negative on "stale"). Clinical
harm from a false negative is far worse than inconvenience from a false
positive, so the policy is biased toward *refusing* once a defensible age is
passed.

---

## 4. Policy recommendation (explicit thresholds)

```
FRESH_WINDOW_MS = 7 days     → normal amber "cached as of" banner, serve.
STALE_WINDOW_MS = 7–30 days  → red escalated warning, still serve (offline usefulness).
HARD_EXPIRY_MS = 30 days     → REFUSE to serve; show "too old to trust" empty state.
```

**Rationale**

- **7 days (fresh).** A routine emergency-card reading cadence; a CHW/responder
  revisiting within a week is very likely looking at still-accurate baseline
  info. The existing amber banner is sufficient.
- **7–30 days (stale).** Real clinical detail (allergies, meds, conditions) can
  change in this window. We *still serve* — losing the card entirely during a
  multi-week outage is worse than showing it with a loud warning — but the
  banner turns red and explicitly says "details may have changed, verify with
  the patient or facility".
- **>30 days (expired).** Beyond any defensible clinical usefulness for a
  possibly-medical snapshot. We **refuse to display it** and show a distinct
  "Cached card too old to trust" state rather than a silently-stale medical
  record. This is the fail-closed boundary.

These constants are centralised in `OFFLINE_FRESHNESS_POLICY` and are trivially
tunable per clinical guidance without touching logic.

**User-facing copy / failure states (acceptance criterion #3)**

- Fresh: "Showing cached data as of {date}. This may be out of date — verify
  with the patient or facility when you can." (amber, unchanged)
- Stale: "Cached {date} — over a week old. Allergy, medication, and condition
  details may have changed. Verify with the patient or facility before trusting
  this card." (red, `aria-live="assertive"`)
- Expired: a full-page honest empty state: "Cached card too old to trust" —
  distinct from the never-visited "No cached card available" state, so a
  responder understands *why* nothing is shown.
- Never visited / evicted: unchanged "No cached card available" fallback.

---

## 5. Revocation, rotation, and unreachable-network behaviour

This spike's **prototype** handles the *cache-age* half. The *revocation* half
is intentionally bounded by what is possible offline:

- **Unreachable network (dead zone).** The cached snapshot is served per §4.
  No network call is ever introduced on the happy path, so the core offline
  guarantee is preserved (acceptance criterion #2: "revoked/rotated cards and
  unreachable-network behavior are addressed" — at minimum the *age* bound
  prevents an indefinitely-stale leaked card).
- **Revoked / rotated card ID.** A device that cached the *old* URL and never
  reconnects can never learn about the rotation offline — this is a
  fundamental limit of login-free offline access, not a gap this spike claims
  to close. The *residual risk window* is explicitly: **≤ HARD_EXPIRY_MS
  (30 days)**. The full fix belongs to Lafiya-xyz/Lafiya-web issue #6
  (card-ID rotation → revocation propagation), which adds (a) immediate ISR
  invalidation server-side and (b) a best-effort online revocation beacon the
  service worker checks opportunistically on any reconnect. This spike's
  policy is deliberately **decoupled but compatible** with that work: it bounds
  the worst case to 30 days even if the beacon never fires.

---

## 6. Prototype (tested against existing cache helpers)

Implemented in `public/offline-cache-helpers.js` and exercised directly by
`tests/unit/offline-freshness.test.ts` (acceptance criterion #4):

- `OFFLINE_FRESHNESS_POLICY`, `FRESHNESS_STATE` — centralised thresholds.
- `classifyCachedFreshness(cachedAtIso, nowMs)` — pure, timezone-safe,
  **fail-closed** (unparseable/future → `expired`).
- `buildFreshnessBannerHtml(isoString, state)` — amber for fresh, red for stale.
- `buildOfflineNavigationResponse({ cachedHtml, cachedAt, now })` — now routes
  through the classifier: fresh → normal banner, stale → red warning, expired →
  `OFFLINE_EXPIRED_HTML` (refused), no HTML → never-visited fallback.
- `injectBanner` refactor so `injectOfflineBanner` and the freshness path share
  identical insertion semantics (backwards compatible; existing
  `offline-cache-helpers.test.ts` still passes).

**Test coverage (24 tests, all passing):** every freshness branch, fail-closed
on bad timestamps, banner insertion, and integration with the pre-existing
`planCacheAdmission` eviction helper (proving the policy does not perturb
cache accounting).

`public/sw.js` already calls `buildOfflineNavigationResponse({ cachedHtml,
cachedAt })` on the offline path; the new `now` default keeps behaviour correct
without further changes.

---

## 7. Follow-up implementation specification

1. **Make thresholds configurable** via env/runtime config so clinical ops can
   tune `FRESH_WINDOW_MS` / `HARD_EXPIRY_MS` without a deploy.
2. **Surface cached attestation date** in the banner when the card page embeds
   it, so responders see both "cached at" and "attestation issued at".
3. **Online revocation beacon** (paired with issue #6): on any successful
   `/card/*` navigation, fire a lightweight status check; if the card's
   `card_public_id` no longer resolves, purge the cached entry and show the
   revoked state.
4. **Background/periodic sync** opportunistically re-validate cached card IDs
   when connectivity returns, even without a fresh visit to that exact URL.
5. **Telemetry**: count how often stale vs. expired vs. fresh cards are served
   offline, to validate the thresholds against real field data.
6. **Docs**: port this policy summary into `docs/card-caching-strategy.md` and
   the patient-facing "what offline means" FAQ.

---

## 8. Acceptance-criteria checklist

- [x] Analysis distinguishes cached freshness from on-chain attestation freshness (§2).
- [x] Revoked/rotated cards and unreachable-network behavior are addressed (§5; age-bound + delegation to #6).
- [x] Recommendation defines user-facing copy and failure states (§4).
- [x] Prototype is tested against the existing service-worker cache helpers (§6, 24 passing tests).

Closes #161.
