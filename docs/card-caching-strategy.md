# Public Card Page and Offline Caching Strategy

## Summary

Live public-card responses are deliberately dynamic and `no-store`; only the
service worker retains a bounded, explicit offline envelope. See
[ADR-003](adr-003-emergency-access-capabilities.md) for the capability and
offline trust model.

## Problem

An ISR document can outlive an authorization change, rotation, revision, or
consent withdrawal while still looking live. That is unsafe for a bearer URL.
Caching rendered HTML in the service worker has the same problem: old markup
can present a stale verification badge without saying what is stale.

The capability resolver does a narrow database lookup on every live
navigation. It is the authorization boundary and atomically applies expiry,
revocation, and bounded-view policy. Access accountability runs with Next
`after()` and cannot delay the response.

## Decision

The caching strategy is therefore:

- **Live:** `/card/*` uses dynamic, `private, no-store` responses. Referrer,
  CSP, and robot headers protect the bearer URL from third-party leakage.
- **Offline:** after a successful real visit and explicit consent, `public/sw.js`
  extracts a versioned emergency envelope from the response, rather than
  caching the HTML. It is bounded to 60 entries / 3 MiB and expires after 72
  hours or earlier when its authorization expires.
- **Reconnect:** a current valid response replaces the envelope; a revoked,
  expired, consent-withdrawn, malformed, or unavailable response removes it.

This fails closed online and remains clinically useful offline without
pretending cached information is currently authorized or freshly verified.

## Files changed

- `app/(public)/card/[id]/page.tsx` and `app/(public)/card/c/[token]/page.tsx`
  — live public-card resolvers
- `public/sw.js` and `public/offline-cache-helpers.js` — envelope admission,
  validation, bounded storage, and unhydrated offline rendering
- `supabase/migrations/20260821170000_emergency_access_capabilities.sql` —
  bounded capability authorization and legacy sunset enforcement

## Freshness guarantee

Every online navigation reads the current authorized projection. Offline data
has independent data, authorization, attestation, and cache timestamps. A
device that stays permanently offline cannot learn a later revocation; the
72-hour envelope maximum limits Lafiya's own cached presentation but cannot
erase screenshots, printouts, or copied data.

## Storage eviction (Issue #875)

Cache Storage is best-effort. If it's evicted, the patient's offline card
disappears without warning. The profile page's offline-readiness check
(`OfflineStorageStatus` → `lib/offline/readiness.ts`) reads only the
`x-lafiya-cached-at` metadata of entries in `lafiya-emergency-envelopes-v2`
and never decrypts an envelope. It reports one of these states:

| State         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `ready`       | An envelope is present and newer than the 72 h maximum age                  |
| `stale`       | An envelope is present but past 72 h. The SW will refuse to render it       |
| `evicted`     | A local marker says an envelope existed, but the cache is now empty         |
| `missing`     | No envelope and no marker: never saved on this device, or everything wiped |
| `unsupported` | No Cache Storage API                                                        |

The marker (`lafiya-offline-readiness-v1` in `localStorage`) stores the newest
`cachedAt` seen and the time it was last verified. It holds no card data.

| Platform            | Eviction behaviour                                                                                                                  | Guidance shown                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Chrome Android      | Best-effort storage can go under storage pressure. `navigator.storage.persist()` (the "Protect offline card" button) prevents that | Backup (print / wallet pass / wallpaper) when not `ready`          |
| Safari iOS, tab     | ITP deletes **all** script-writable storage after 7 days of browser use with no visit to the site                                  | Always: Add to Home Screen, plus backups                           |
| Safari iOS, home-screen PWA | Exempt from the 7-day ITP deletion                                                                                          | Backup only when not `ready`                                       |

**Known limitation:** ITP also deletes `localStorage`, so after an ITP wipe the
marker is gone and the state shows as `missing`, not `evicted`. That's why the
iOS-tab guidance is shown no matter what state the check reports. The patient
still sees that there's no offline copy, so the loss isn't silent.

The manual matrix (Chrome Android, Safari iOS tab, iOS installed PWA) still
has to be run on real devices. Expected result: `ready` after viewing the card
online; `missing` on iOS tab after 7+ days with no visit; `evicted` after
clearing site data except `localStorage` (e.g. DevTools → Cache Storage →
delete).

## Verification

- `npm run typecheck`
- `npm test`
- `npm run test:integration`
- `npm run migration:lint`

## Follow-up

Load-test live capability resolution separately from the offline-envelope cache
path; neither path may log a raw capability or patient data.
