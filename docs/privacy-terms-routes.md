# Privacy and Terms Routes

## Summary

Added `/privacy` and `/terms` routes with versioned content, linked from the global footer, the signup page, and the public card page. The signup flow now requires explicit consent to the privacy policy before creating a card.

## Problem

There was no `/privacy` or `/terms` route, and nothing in the app rendered a privacy notice. The README described the intended compliance posture in prose, but a patient signing up had nothing to actually read or link to. This also blocked the consent-capture flow, because you cannot require consent to a document that does not exist.

## What was added

### Routes

- `app/privacy/page.tsx` — privacy policy covering:
  - What data is collected (the emergency subset only)
  - Why it is collected
  - Where it is stored (Supabase Postgres with RLS)
  - On-chain vs off-chain separation (no health data on Stellar; only hashes and attestations)
  - Data retention and deletion
  - User rights (export/delete)
  - Contact information
- `app/terms/page.tsx` — terms of service covering:
  - Pre-alpha software disclaimer
  - Not a substitute for professional medical judgment
  - User responsibilities
  - Availability as-is
  - Governing law under NDPR

Both pages are versioned with a visible `Version` and `Last updated` date (`v1.0.0`, `2026-07-17`) so the consent-log flow has a concrete reference string.

### Links

- `app/layout.tsx` — global footer with Privacy and Terms links
- `app/(auth)/signup/page.tsx` — required consent checkbox with a link to `/privacy`
- `app/(public)/card/[id]/page.tsx` — Privacy · Terms links near the medical disclaimer

### Consent enforcement

- `app/(auth)/signup/actions.ts` — added `consent` to the Zod schema; signup now fails with a validation error if the checkbox is not ticked

## Files changed

- `app/privacy/page.tsx` (new)
- `app/terms/page.tsx` (new)
- `app/layout.tsx`
- `app/(auth)/signup/page.tsx`
- `app/(auth)/signup/actions.ts`
- `app/(public)/card/[id]/page.tsx`

## Verification

- `npm run typecheck` — passes
- `npm run lint` — passes
- `npm test` — 22 tests pass

## Follow-up

Cross-check the final policy copy against `lafiya-docs` for consistency before merging. When the consent-log feature lands, reference `privacy v1.0.0` explicitly in the consent record.

## Nearest-facility directory and location (#763)

The responder card can show a nearby health-facility list. The device's
location is requested only when the responder taps "Sort by distance" and is
processed **on-device only**: it is used in the browser to compute
straight-line distances and is never sent to Lafiya or any third party. The
facility shards themselves (`/facilities/<state>.json`) contain only public
registry data and are cached by the service worker after first use so the list
works offline. See `docs/facility-directory.md`.
