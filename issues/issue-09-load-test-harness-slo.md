## Title
Build a statistically rigorous load-testing and regression-detection harness for the public emergency-card read path, and establish a concrete, measured concurrency/latency SLO (the current harness is non-functional and no real number has ever been produced)

## Difficulty
10/10 — Expert. Estimated effort: 4–6 days for a senior engineer.

## Context
The public emergency card (`app/(public)/card/[id]`) is, per the README and `docs/perf-budget.md`, the single most latency-critical page in the product: it must be readable within seconds on a 2G/EDGE connection by a responder in the field. `docs/loadtest_get_emergency_card.md` and `loadtest/k6_get_emergency_card_test.js` claim to establish and verify a performance budget for this path under concurrent load, and `.github/workflows/loadtest-get-emergency-card.yml` claims to run this periodically. In practice, every piece of this pipeline is broken or was never actually run to produce a real result:

1. **The database seed script cannot run.** `supabase/seed_loadtest.sql` inserts into `public.profiles` using a column named `id` (`INSERT INTO public.profiles (id, name, ...)`), but `supabase/migrations/20260709110710_profiles_table.sql` defines the table's primary key as `user_id uuid primary key references auth.users (id) on delete cascade` — there is no `id` column on `public.profiles` at all, and `user_id` is `NOT NULL` with a foreign-key constraint to `auth.users`, which the seed script never populates. Running this script as documented (`psql $SUPABASE_DB_URL -f supabase/seed_loadtest.sql`) fails outright with a column-does-not-exist (or FK-violation) error — the 1000-row dataset the load test depends on has never actually been created by this script.
2. **The k6 script itself is broken.** `loadtest/k6_get_emergency_card_test.js:26` requests `${__ENV.BASE_URL}/public/card/${id}` — but the real route is `/card/[id]` (`app/(public)/card/[id]/page.tsx`), not `/public/card/[id]` (the `(public)` segment is a Next.js route group, which is deliberately excluded from the URL path). Every request in this script 404s. Separately, line 30 references `errorRate.add(1)` — `errorRate` is never declared, imported, or defined anywhere in the file, so the very first failed `check()` throws a `ReferenceError` and aborts the iteration.
3. **No real result has ever been produced.** `docs/loadtest_get_emergency_card.md`'s own "Decision Log" states: "Target concurrency: TBD (based on stakeholder input)" and "Acceptable latency: p95 < 1500 ms ... (adjust as needed)" — placeholder values, not measured or committed targets. Given (1) and (2) above, there is no way this number was ever actually derived from a real run against this schema and this route.

The result: the project has no verified answer to "how many concurrent responders scanning cards can this actually serve, and at what latency," despite this being explicitly called out as the load-bearing performance question for the product's core use case.

## Problem statement
Fix the load-testing pipeline end-to-end (correct seed script, correct k6 script, correct CI wiring) and use it to establish a real, measured, statistically defensible concurrency/latency SLO for `get_emergency_card` and the `/card/[id]` page as actually deployed — not a single noisy run's p50/p95, but a methodology that can distinguish a genuine performance regression from ordinary run-to-run variance, accounting for the specific caching behavior this route relies on (`revalidate = 60` ISR, per `app/(public)/card/[id]/page.tsx:17`) and the connection-pooling limits of the Supabase Postgres instance backing it.

## Current behavior
- `supabase/seed_loadtest.sql` — references a nonexistent `id` column on `public.profiles`; fails to run against the actual current schema.
- `loadtest/k6_get_emergency_card_test.js:26` — wrong URL path (`/public/card/` instead of `/card/`).
- `loadtest/k6_get_emergency_card_test.js:30` — references an undefined `errorRate` variable, throwing on the first failed check.
- `docs/loadtest_get_emergency_card.md` — documents placeholder ("TBD", "adjust as needed") targets, not measured ones.
- `.github/workflows/loadtest-get-emergency-card.yml` exists but, given the above, cannot have ever produced a meaningful passing or failing result.

## Required behavior
- A seed script that correctly populates `public.profiles` against the real schema (correct primary key, satisfying the `user_id` foreign key — which itself requires either seeding matching `auth.users` rows or using Supabase's admin API to create them, since `user_id` cannot reference a nonexistent auth user) at a scale realistic for this product's near-term deployment (state and justify the row count).
- A corrected k6 (or equivalent) script that hits the real `/card/[id]` route, correctly reports errors, and captures p50/p95/p99 latency and error rate.
- A methodology — not just a single run — for distinguishing a real regression from noise: multiple runs, statistical treatment of variance (e.g., a documented confidence interval or a minimum-N-runs-before-flagging-a-regression rule), and explicit handling of the fact that this route's ISR caching means "concurrent requests to the *same* card ID" and "concurrent requests to *many distinct* card IDs" are fundamentally different load profiles with very different expected latencies — your harness must exercise and separately report both, since a naive single-metric result conflates a cache-hit-dominated benchmark with a realistic multi-patient production load.
- An analysis (backed by the actual test results, not assumed) of whether Supabase's connection pooler (transaction-mode PgBouncer, per Supabase's standard architecture) becomes a bottleneck before the application layer does at your tested concurrency, and what connection-pool-size tuning (if any) is required.
- A concrete, defended concurrency/latency SLO replacing the "TBD"/"adjust as needed" placeholders in `docs/loadtest_get_emergency_card.md`, with the actual measured numbers that justify it.
- CI wiring (`.github/workflows/loadtest-get-emergency-card.yml`) that runs the corrected harness and fails the build on a statistically meaningful regression against the established baseline — not a single-run threshold check vulnerable to noise.

## Constraints
- Must run against a local `supabase start` instance for reproducibility (matching this project's existing integration-test pattern) — do not require a hosted staging environment as a hard dependency for the harness to be runnable and verifiable by any contributor.
- k6 remains the tool (already a project dependency in intent, per the existing script) unless you can justify a replacement is materially better for the statistical-rigor requirement above.
- Must not modify `app/(public)/card/[id]/page.tsx`'s actual caching behavior as part of this issue — you are measuring and documenting its behavior under load, not changing it (a follow-up issue, not this one, would act on findings that suggest the caching strategy itself needs to change).
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] `supabase/seed_loadtest.sql` (or its replacement) runs successfully against a freshly-reset local Supabase instance and produces the documented number of valid, queryable `profiles` rows with distinct `card_public_id`s.
- [ ] The corrected load-test script successfully exercises the real `/card/[id]` route end-to-end against a local build, with zero script-level errors (no `ReferenceError`, no 404s from a wrong path) over a full run.
- [ ] The harness separately measures and reports (a) repeated-hits-to-the-same-card latency (cache-hit-dominated) and (b) hits-spread-across-many-distinct-cards latency (cache-miss/database-bound), with the difference between the two explicitly quantified in the results.
- [ ] A written methodology section (in `docs/loadtest_get_emergency_card.md` or a new doc) specifying how many runs are needed and what statistical criterion distinguishes a genuine regression from noise, applied to at least two real consecutive runs as a worked example.
- [ ] `docs/loadtest_get_emergency_card.md`'s Decision Log is updated with real, measured target concurrency and latency numbers (no "TBD" remaining), each backed by a cited run in the PR.
- [ ] `.github/workflows/loadtest-get-emergency-card.yml` is updated to run the corrected harness and demonstrably fails on an injected regression (prove this — e.g., temporarily introduce a synthetic slowdown, show the workflow catches it, then revert).

## Out of scope
- Changing `app/(public)/card/[id]/page.tsx`'s caching strategy itself based on findings — file a follow-up recommendation in the PR instead of implementing a caching change here.
- Load-testing any other route (`/api/attestation/[recordHash]`, the profile editor, avatar upload) — this issue is scoped to `get_emergency_card`/`/card/[id]` only.
- Provisioning or tuning a production/staging Supabase project's actual connection-pool configuration — your analysis should inform that decision, but changing hosted infra configuration is out of scope for this repo-scoped issue.

## Hints and references
- k6's own documentation on `Trend`/`Rate` custom metrics and threshold configuration (`https://k6.io/docs/using-k6/metrics/`), to correctly define the missing `errorRate` metric and structure separate metrics for the same-card vs. many-cards scenarios.
- Supabase's documented Postgres connection-pooling architecture (transaction-mode PgBouncer defaults and connection limits per plan tier) as the basis for your bottleneck analysis.
- Statistical approaches to performance-regression detection in CI (e.g., Mann-Whitney U test or a simple multiple-of-baseline-standard-deviation threshold across N historical runs) — pick one appropriate to the scale of this project and justify it; a single-run p95 threshold, as exists today, is exactly the naive approach this issue exists to move past.
