# Test-coverage and doc/CI drift fixes — 2026-08-30

Summary of four small, independent fixes. Each has its own commit.

## 1. `lib/chw-protocol/config.test.ts` — malformed-config coverage

Previously only asserted two production-config error paths. Added four more
cases, each with an exact-message assertion:
- Production config missing only `CHW_PROTOCOL_INTENT_SIGNING_KEY`
  (`PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE`).
- Production config missing only `CHW_PROTOCOL_EPOCH_ID`
  (`PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE`).
- `ATTESTATION_MODE` set to a value outside `["mock", "live"]` — asserts a
  `ZodError` is thrown, message names the bad value.
- `LAFIYA_DEPLOYMENT_ENV` set to a value outside the deployment enum — same
  shape of assertion.

## 2. `lib/stellar/attestation-caching.test.ts` — TTL expiry coverage

The existing `next/cache` mock cached forever (keyed only by args), so it
could never exercise expiry. Rewrote the mock to honor `unstable_cache`'s
`revalidate` option as a real TTL against `Date.now()`, then added two tests
using `vi.useFakeTimers()` and a spy on `attestationBreaker.execute` (the
underlying uncached fetch) to prove:
- A repeat lookup inside the TTL window is served from cache (fetch called
  once).
- A repeat lookup after the TTL has elapsed triggers a real re-fetch (fetch
  called twice), rather than serving the "verified" status indefinitely.

`docs/attestation-caching-perf.md` gained a short section pointing at this
coverage.

## 3. `docs/lighthouse-ci-setup.md` vs `.github/workflows/ci.yml` — drift check

Compared the doc line-by-line against the `performance` job in
`ci.yml` and against `.lighthouserc.json`.

- **Found:** the doc said `supabase/setup-cli@v1`; the workflow actually
  pins `supabase/setup-cli` to a commit SHA tagged `v3`. Fixed the doc to
  match the workflow (workflow is source of truth, per this repo's
  SHA-pinning supply-chain policy).
- **Confirmed matching (no change needed):** all budget thresholds
  (performance ≥0.85, accessibility ≥0.9, LCP ≤2500ms, TBT ≤200ms,
  CLS ≤0.1, JS/document/total payload caps), 3 runs, mobile form factor, and
  Slow-4G throttling all match `.lighthouserc.json` exactly.

## 4. `e2e/signup-to-card.spec.ts` — pre-profile onboarding state

Added a second `test.describe` that signs up a brand-new user and stops at
`/profile` *before* filling in or saving any profile data (no `profiles` row
exists yet). Asserts:
- The page renders a sensible empty/onboarding state (`"Your Lafiya card"`
  heading + account email, empty profile form) instead of erroring.
- Card-sharing / QR / privacy-controls UI, which only make sense once a
  profile exists, are absent rather than rendering broken.
- No `console.error` or uncaught page errors fire while in this state.
