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

## Verification

- `npm run typecheck`
- `npm test`
- `npm run test:integration`
- `npm run migration:lint`

## Follow-up

Load-test live capability resolution separately from the offline-envelope cache
path; neither path may log a raw capability or patient data.
