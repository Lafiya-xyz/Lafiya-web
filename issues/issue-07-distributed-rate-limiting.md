## Title
Replace the in-memory, per-instance rate limiter protecting patient sign-in with a distributed, atomicity-correct backend that provides real brute-force protection under Vercel's serverless deployment model

## Difficulty
10/10 — Expert. Estimated effort: 3–5 days for a senior engineer.

## Context
`lib/rate-limit.ts` is the sole brute-force/credential-stuffing defense for patient accounts, used by `app/(auth)/signin/actions.ts`. Its own docstring states the intent plainly: "Implements application-level rate limiting keyed on email + IP to protect sensitive patient accounts from credential stuffing and brute-force attacks," with a documented exponential-backoff policy (30s → 60s → ... → capped at 900s after 5+ consecutive failures). This is a meaningful security control for an app whose accounts gate access to a patient's blood group, genotype, allergies, medications, and emergency contacts (`lib/supabase/types.ts`'s `ProfileRow`) — exactly the kind of data NDPA 2023 and the README's stated privacy posture treat as sensitive.

The implementation stores all state in a plain in-memory `Map`, attached to `globalThis` specifically "to survive Hot Module Replacement (HMR) during dev" (`lib/rate-limit.ts:9-15`). The README states the app is deployed to Vercel (`Dependencies` section: "Node.js 24+ / Next.js 16 (App Router) — deployed on Vercel"). Vercel's serverless/Fluid Compute execution model does not guarantee that concurrent invocations of the same Server Action share a process, and does not guarantee any particular invocation reuses a warm instance rather than spinning up a fresh one — under real attack traffic (many concurrent requests, which is precisely what a credential-stuffing attack looks like), requests are very likely to be spread across multiple isolated function instances, each with its own independent, empty `rateLimitStore`. The "lock out after 5 failed attempts" guarantee the docstring and the passing unit tests (`app/(auth)/signin/actions.test.ts`) demonstrate is real *only within a single warm instance's memory* — it provides materially weaker protection than advertised against the actual threat (distributed, concurrent brute-force traffic) once deployed, and there is nothing in the codebase or tests that exercises or acknowledges this gap: every test in `app/(auth)/signin/actions.test.ts` runs single-threaded against one in-process store, so the passing test suite gives false confidence about production behavior.

There is also a correctness gap independent of the distribution problem: `recordFailure` (`lib/rate-limit.ts:52-67`) performs a non-atomic read-modify-write (`store.get` → mutate → `store.set`) on the shared record. Even within a single instance, concurrent requests for the same rate-limit key (e.g., a script firing several sign-in attempts in parallel rather than sequentially) can race: two concurrent calls can both read the same `attempts` count before either writes back, undercounting the true number of failures and delaying lockout past the intended threshold.

## Problem statement
Replace the rate-limiting backend with one whose state is durable and consistent across concurrent, distributed invocations of the sign-in Server Action, correctly enforcing the existing exponential-backoff contract (same thresholds: no restriction for attempts 1–4, 30s lockout at attempt 5, doubling up to a 900s cap) even when attack traffic is spread across many concurrent, independent serverless instances, and even when multiple requests for the same key arrive concurrently (the increment-then-check must be atomic — no lost updates).

## Current behavior
- `lib/rate-limit.ts:9-15` — `globalStore.rateLimitStore` is a plain in-memory `Map`, explicitly scoped to a single process/instance.
- `lib/rate-limit.ts:52-67` (`recordFailure`) — non-atomic get/mutate/set on the shared record; no locking or compare-and-swap.
- `app/(auth)/signin/actions.ts` — calls `checkRateLimit`/`recordFailure`/`recordSuccess` from this module as the entire brute-force defense; there is no secondary defense (no CAPTCHA, no Supabase-side lockout) in front of `supabase.auth.signInWithPassword`.
- `app/(auth)/signin/actions.test.ts` — all tests pass today, but exercise only single-instance, effectively-sequential behavior; none simulate concurrent requests or multiple isolated store instances (i.e., none simulate what actually happens on Vercel under real attack load).

## Required behavior
- Rate-limit state must live in a backend that is genuinely shared across all instances handling requests for this app (Postgres via the existing Supabase project is the natural, no-new-infra choice given this project's constraints — justify your choice either way).
- The check-and-increment operation for a given rate-limit key must be atomic under concurrency: N simultaneous failed attempts for the same key must result in exactly N recorded failures, never fewer, regardless of how many separate serverless instances handled them.
- The existing exponential-backoff thresholds and messaging contract (`checkRateLimit`'s `allowed`/`secondsRemaining` shape, `recordFailure`'s 5-attempts-then-30s-doubling-to-900s-cap policy) must be preserved exactly — `app/(auth)/signin/actions.ts` and its existing passing tests must not need to change their assertions about *policy*, only about how the backend is exercised in new concurrency tests.
- Must not add meaningful latency to the sign-in happy path (a single extra indexed Postgres round trip is acceptable; an unbounded or unindexed table scan is not).

## Constraints
- No new infrastructure dependency (no standalone Redis/Upstash instance, no external rate-limiting SaaS) unless you can show the existing Supabase Postgres project cannot meet the atomicity/latency requirements — prefer solving this with a new table + `INSERT ... ON CONFLICT DO UPDATE` / `SELECT ... FOR UPDATE`-style atomic SQL, consistent with this project's existing "just Supabase, no extra infra" posture.
- Must preserve the "keyed by email + IP" scheme and the non-enumerating error messaging already in place (do not reveal whether an email exists).
- Must not regress `app/(auth)/signin/actions.test.ts`'s existing passing assertions about lockout policy.
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] A new migration adds whatever table/schema the distributed rate limiter needs, with RLS/grants scoped correctly (service-role-only writes, consistent with this project's existing pattern for privileged tables like `chw_payouts`).
- [ ] `checkRateLimit`/`recordFailure`/`recordSuccess` are reimplemented against the durable backend with the same external signatures (or a clearly justified, minimal signature change), preserving all existing passing tests in `app/(auth)/signin/actions.test.ts` without weakening their assertions.
- [ ] A new test proves atomicity under concurrency: firing N concurrent `recordFailure` calls for the same key (simulated via `Promise.all`, or, if feasible, via genuinely parallel separate process/connection simulation) results in exactly N recorded attempts, not fewer.
- [ ] A new test simulates the "distributed instances" scenario meaningfully — e.g., by instantiating two independent client connections/handles to the backend representing two different serverless instances, and proving that a lockout triggered via one is immediately visible and enforced via the other.
- [ ] A benchmark or documented measurement showing the added latency on the sign-in happy path is small and bounded (state the number in the PR).
- [ ] `npm run test:integration` passes against a local Supabase instance exercising the new table.
- [ ] `npm run typecheck` and `npm run lint` pass.

## Out of scope
- Any change to the actual password-authentication call (`supabase.auth.signInWithPassword`) itself.
- Adding CAPTCHA, WebAuthn, or other secondary auth-hardening mechanisms — this issue is scoped to making the existing rate-limit *mechanism* actually work as designed, not to adding new defenses.
- Applying the same distributed-rate-limit treatment to `app/api/attestation/[recordHash]/route.ts` or the avatar upload route (worth doing, but out of scope here — keep this issue independently mergeable; if you believe those routes need it too, note it in the PR as a follow-up rather than expanding this issue's scope).

## Hints and references
- PostgreSQL atomic upsert patterns (`INSERT ... ON CONFLICT (key) DO UPDATE SET attempts = table.attempts + 1 ...` with a `RETURNING` clause) for lock-free, race-safe counters, versus explicit `SELECT ... FOR UPDATE` row locking — pick one and justify the tradeoff (throughput vs. simplicity) in the PR.
- Vercel's documentation on serverless function concurrency/instance lifecycle, for correctly reasoning about (and citing in your PR) why the current design fails in production.
- General distributed rate-limiting algorithms (token bucket, sliding window log, fixed window with atomic increment) — the existing policy is closer to a "failure-count-with-exponential-lockout" scheme rather than a classic rate limiter; preserve that exact policy shape rather than substituting a different algorithm's semantics.
