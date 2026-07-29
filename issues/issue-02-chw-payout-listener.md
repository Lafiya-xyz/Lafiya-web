## Title
Build the on-chain event listener/indexer that populates `public.chw_payouts` from Stellar attestation and USDC payout events

## Difficulty
10/10 — Expert. Estimated effort: 5–8 days for a senior engineer.

## Context
`supabase/migrations/20260717120000_chw_payouts.sql` creates the `chw_payouts` table and states its purpose explicitly in the migration header: it is "a queryable, RLS-protected mirror, populated by a listener process that observes attestation + payout events on-chain and writes/updates rows here so a CHW can see their own earnings without running a Stellar block explorer query themselves." The README's M2 milestone ("USDC-on-Stellar payout wired to attestation events", "CHW payout tracking") is unchecked, and the Architecture diagram shows `ATTEST --> ALLOW` and `PAY --> CHW` as core data flows this repo is responsible for surfacing.

No such listener exists anywhere in the repository. A repo-wide search for `listener`, `indexer`, `streamEvents`, or any Horizon/Soroban event-subscription code returns nothing outside the migration's own comments. The table has a unique constraint on `record_hash` and a `status` state machine (`pending` → `paid`, enforced by `chw_payouts_paid_requires_tx`), clearly designed to be written by exactly this kind of process — but the process is entirely unbuilt. Without it, the CHW incentive rails described as core to the project's mission ("get paid in USDC on Stellar for each person registered and verified, solving the last-mile distribution problem") have no working data path: `chw_payouts` will sit permanently empty, and CHWs have no way to see whether they've been paid.

## Problem statement
Design and implement a durable event-indexing service that:
1. Observes Soroban contract events (or, if events aren't emitted by the `attest` function per the current `lafiya-contracts` interface, polls `get_attestation`/ledger state as a fallback — you must determine which is actually available and justify your choice) to detect new attestations, and inserts a `pending` row into `chw_payouts` for each newly attested `record_hash` with the attesting CHW's Stellar address and the attestation timestamp.
2. Observes Stellar payment operations (USDC trustline payments) to the CHW incentive pool/allowlisted CHW addresses, correlates each payment to the corresponding `pending` `chw_payouts` row, and transitions it to `paid` with the observed `payout_tx_hash` and `paid_at`.
3. Is crash-safe and resumable: the process must persist a durable cursor (last-processed ledger sequence or paging token) so that a restart, deploy, or crash resumes from where it left off rather than reprocessing the entire ledger history or silently skipping a gap.
4. Is idempotent: reprocessing the same ledger range (e.g., after a crash mid-batch) must not produce duplicate rows or violate the `chw_payouts_record_hash_unique` constraint — upserts must be safe to retry.
5. Handles the two event streams (attestation events, payout events) arriving out of order or with the payout observed before its corresponding attestation row exists yet (a race the naive "insert then update" model doesn't handle).

## Current behavior
- `supabase/migrations/20260717120000_chw_payouts.sql` — table exists, RLS-scoped to `chw_id`, writes are default-denied to `authenticated` (only a `select` policy exists; no `insert`/`update` policy for any client role), implying only a service-role process is meant to write to it. No such process exists.
- No file in `lib/`, `scripts/`, or `app/` references Stellar Horizon, ledger streaming, or any payout-observation logic.
- No environment variables for a listener's own cursor/checkpoint storage, USDC asset issuer, or CHW incentive pool address exist in `lib/env.ts`/`lib/env-server.ts`.
- `app/api/attestation/[recordHash]/route.ts` and `lib/stellar/attestation.ts` only ever *read* attestation state; nothing in the repo *writes* or *observes* on-chain writes.

## Required behavior
- A runnable process (a script under `scripts/` invoked by a scheduled job, or a Route Handler designed to be safely invoked repeatedly by an external scheduler/cron — your call, justify it) that, given a configured Soroban RPC/Horizon endpoint and contract ID, produces correct, idempotent `chw_payouts` rows reflecting on-chain reality.
- A documented, tested reconciliation strategy for the attestation-before-payout and payout-before-attestation race.
- A documented, tested backfill/catch-up path: given a fresh empty `chw_payouts` table and a checkpoint reset, the process must be able to reprocess history from a configurable starting ledger without manual intervention.
- Structured logging via `lib/logging/logger.ts`'s `logInfo`/`logError` (per this repo's own operational rules) for every processed event and every reconciliation decision, with no patient health data ever in scope here (payout events never carry patient data, so this is a lower-risk logging surface than the profile/card path, but still route through the shared logger for consistency).

## Constraints
- Must write through a Supabase client using the service role (`lib/supabase/admin.ts`'s `createAdminClient`), since RLS on `chw_payouts` grants no write access to any non-service role — do not add a permissive RLS policy as a shortcut.
- Must not modify the `chw_payouts` schema in a way that breaks the existing `status`/`payout_tx_hash` check constraint contract, unless a new migration is added that preserves backward-compatible semantics for any already-written rows.
- No new heavy message-queue infrastructure (Kafka, RabbitMQ) — this must run within the project's existing Supabase + serverless/cron deployment model.
- Must not fabricate or synthesize payout data in the absence of real on-chain events — if the `lafiya-contracts` repo's `attest` function does not currently emit a subscribable event, you must build against whatever read primitive Soroban actually exposes today (state polling via `get_attestation`/ledger entries) and document that constraint explicitly rather than assuming an event stream that may not exist.
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] A documented design decision (in the PR) on event-source strategy (event subscription vs. polling) with justification tied to what `lafiya-contracts`/Soroban RPC actually exposes.
- [ ] Unit tests proving idempotent upsert behavior: running the same batch of synthetic on-chain events twice produces exactly one row per `record_hash`, no constraint violations.
- [ ] Unit tests proving crash-resume correctness: simulate a crash after partially processing a batch, restart from the persisted cursor, and prove no event is skipped and none is double-applied.
- [ ] A test proving the out-of-order race (payout event observed before the attestation row exists) resolves correctly to a `paid` row once both events are processed, regardless of arrival order.
- [ ] An integration test (extending the pattern in `tests/integration/`) that runs the listener against a local Supabase instance and asserts the resulting `chw_payouts` rows via the service-role client.
- [ ] `npm run typecheck`, `npm run lint`, and the existing test suite continue to pass.

## Out of scope
- Any change to the `lafiya-contracts` Rust contract itself — if it needs new events emitted to make this tractable, document that as a cross-repo follow-up rather than modifying contracts here.
- The `lafiya-verifier` CHW-facing UI for viewing payouts — this issue is the data pipeline only, not a UI.
- The attestation lookup/circuit-breaker work (separate issue in this batch).

## Hints and references
- Stellar Horizon's `/payments` streaming endpoint and cursor/paging-token model (`https://developers.stellar.org/docs/data/horizon` — streaming and pagination sections) as one viable event-source strategy.
- Soroban RPC's `getEvents` method for contract-emitted events, if `lafiya-contracts`'s `attest` function emits one — verify this against the contract's actual ABI/interface rather than assuming.
- General exactly-once-processing patterns for at-least-once event sources: idempotency keys + durable checkpointing (the `record_hash` unique constraint is already a natural idempotency key for the attestation side; the payout side needs an equivalent, likely the Stellar transaction hash).
