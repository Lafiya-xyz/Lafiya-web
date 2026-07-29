## Title
Close the database-level gap that lets an authenticated user store unbounded array/text data in their own profile and weaponize the public, unauthenticated card endpoint as a bandwidth/memory amplification vector

## Difficulty
10/10 — Expert. Estimated effort: 3–5 days for a senior engineer.

## Context
`docs/perf-budget.md` establishes a hard payload budget for `app/(public)/card/[id]`: "HTML document ≤ 5 kB", "Total (with photo) ≤ 110 kB" — justified because the page must load in seconds over 2G/EDGE for a responder in the field. That budget is enforced today **only** by `lib/validation/profile.ts`'s Zod schema (`allergies`/`medications`/`chronicConditions` each `.max(20)` items, `.max(200)` chars each; `name` `.max(200)`), which runs exclusively inside the `upsertProfile` Server Action (`app/(auth)/profile/actions.ts`).

`supabase/migrations/20260709110710_profiles_table.sql` grants `select, insert, update, delete on public.profiles to authenticated` (line 85) and enables RLS policies that allow any authenticated user to insert/update **their own row** with **any column values that satisfy the column's SQL type**, because Supabase auto-generates a full PostgREST REST API for any granted table, entirely independent of this app's Next.js Server Actions and their Zod validation. The migration's own check constraints only bound `emergency_contacts` (`emergency_contacts_is_bounded_array`, ≤3 elements) — `allergies text[]`, `medications text[]`, and `chronic_conditions text[]` (lines 27-29) have **no check constraint at all** on array length or per-element string length. `name text`, `language text`, and `photo_url text` likewise have no length bound at the database level.

This means any authenticated user can call the Supabase REST API directly (bypassing this app's UI and Server Action entirely — RLS authorizes the request regardless of which client made it, per `tests/integration/rls.test.ts`'s own framing of "owner can insert/update their own row") and set, e.g., `allergies` to an array of millions of large strings, entirely within their own row and entirely RLS-legal. `public.get_emergency_card(p_card_id uuid)` (`supabase/migrations/20260709110953_emergency_card_rpc.sql`) then returns that row's full `allergies`/`medications`/`chronic_conditions`/`emergency_contacts` **unauthenticated, to anyone who knows (or can enumerate/guess, per the related record-hash issue in this batch) that user's own `card_public_id`** — including the user themself, repeatedly, from a script, at no cost beyond their own request rate. This turns a single, legitimately-owned account into a bandwidth/memory amplification primitive against the app's own public, unauthenticated, most-latency-sensitive route: one write of an oversized row, followed by unlimited public reads that each force Postgres to serialize and PostgREST/Next.js to transfer a payload potentially thousands of times the documented 110 kB budget, from a route with `revalidate = 60` ISR caching that will happily cache and re-serve that oversized payload to every subsequent viewer within the TTL window.

## Problem statement
Add database-level bounds — not merely application-level Zod validation — that make it structurally impossible for any row in `public.profiles`, however it is written (via this app's Server Actions, via direct PostgREST access, via a future admin tool, via a bug in a form), to produce a `get_emergency_card` payload that meaningfully exceeds the documented performance budget. The fix must be enforced at the layer that RLS itself cannot bypass (`check` constraints, triggers, or equivalent), because RLS governs *who* can write, not *what shape* the data they write may take.

## Current behavior
- `supabase/migrations/20260709110710_profiles_table.sql:27-29` — `allergies text[] not null default '{}'`, `medications text[] not null default '{}'`, `chronic_conditions text[] not null default '{}'` — no length/size check constraints.
- `supabase/migrations/20260709110710_profiles_table.sql:19,21,22` — `name text not null`, `photo_url text`, `language text` — no length check constraints.
- `supabase/migrations/20260709110710_profiles_table.sql:38-41` — the only existing bound, on `emergency_contacts`, proves the pattern is known and used elsewhere in this exact migration, but was not applied to the other array/text columns.
- `lib/validation/profile.ts` — the only current enforcement, and it is entirely bypassable by any client that talks to Supabase's REST API directly instead of this app's UI.
- `app/(public)/card/[id]/page.tsx:17` — `export const revalidate = 60` means an oversized payload, once triggered, is cached and re-served for up to 60 seconds to every subsequent viewer of that card without hitting the database again — the ISR layer amplifies the blast radius rather than mitigating it.

## Required behavior
- Database-level `check` constraints (new migration, additive, non-breaking to existing valid rows) bounding: the maximum number of elements in `allergies`, `medications`, and `chronic_conditions`, the maximum length of each element string, and the maximum length of `name`, `language`, and `photo_url`. Bounds must be chosen so that the worst-case `get_emergency_card` JSON payload provably stays within a small, explicit multiple of the `docs/perf-budget.md` budget (state your worst-case byte calculation in the PR).
- The bounds must match (or be at least as strict as) `lib/validation/profile.ts`'s existing Zod limits, so a legitimate user going through the normal UI never hits the new DB constraint — the DB constraint is a backstop against bypass, not a new UX-facing limit.
- A demonstrated, tested proof that a direct PostgREST call attempting to exceed the bound is rejected by Postgres itself, independent of any Next.js code path.
- Verification that `get_emergency_card`'s worst-case response size, under the new bounds, is measured and documented (extend `docs/perf-budget.md` with the enforced ceiling, not just the aspirational target).

## Constraints
- Must be an additive migration under `supabase/migrations/` following this repo's existing naming and commenting conventions (see the header-comment style in the existing migrations) — do not edit a past migration file.
- Must not break any existing passing test, in particular `tests/integration/emergency-card-rpc.test.ts` and `tests/integration/profiles-column-contract.test.ts`, whose fixture data must remain valid under the new constraints.
- Must not silently truncate or mutate existing out-of-bound data (there may be none yet, since the app itself never produced any, but the migration must be written defensively as if it might need to run against a populated table — decide and document what a hypothetical violating row would do: fail the migration explicitly with a clear error, rather than corrupt data silently).
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] A new migration adds `check` constraints bounding array length and element/string length for `allergies`, `medications`, `chronic_conditions`, `name`, `language`, and `photo_url`, with values justified against a documented worst-case-payload calculation.
- [ ] A new integration test proves a direct `service-role`-or-`authenticated`-client insert/update attempting to exceed any of the new bounds is rejected by Postgres with a constraint-violation error (not merely by client-side Zod).
- [ ] A new integration test proves the existing valid fixture data used elsewhere in the test suite (`tests/integration/emergency-card-rpc.test.ts`'s seed profile, etc.) still passes under the new constraints.
- [ ] `docs/perf-budget.md` is updated with the now-enforced worst-case payload ceiling for `get_emergency_card`, distinct from the aspirational target.
- [ ] `npm run test:integration` passes against a local Supabase instance with the new migration applied.
- [ ] `npm run typecheck` and `npm run lint` pass.

## Out of scope
- Rate-limiting the public card page itself (a separate, complementary concern — this issue is specifically about bounding payload *size*, not request *rate*).
- The record-hash/attestation-lookup rate-limiting concern raised in the record-hash commitment-scheme issue in this batch.
- Any change to `lib/validation/profile.ts`'s existing limits (they are already adequate; the gap is that they are the *only* enforcement).

## Hints and references
- PostgreSQL `check` constraints on array columns using `array_length(col, 1)` and `cardinality(col)`, and per-element bounding via a helper function or `unnest`-based check (array-element-length checks aren't expressible as a simple inline `check` without a small SQL function — see the existing `emergency_contacts_is_bounded_array` constraint's `jsonb_array_length` pattern in the same migration file for the house style to follow).
- PostgREST's documentation on how RLS and column privileges interact with direct REST access, to correctly reason about (and cite in your PR) exactly why Zod-only validation does not apply to this attack path.
