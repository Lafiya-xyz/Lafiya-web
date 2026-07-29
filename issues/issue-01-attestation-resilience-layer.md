## Title
Rebuild the Soroban attestation lookup layer: fix the broken `unstable_cache` usage, implement the circuit-breaker/timeout resilience contract the test suite already specifies, and decode the full on-chain `Attestation` struct (including `revoked`/`expiry`)

## Difficulty
10/10 — Expert. Estimated effort: 4–6 days for a senior engineer.

## Context
`lib/stellar/attestation.ts` is the single chokepoint between the public emergency card (`app/(public)/card/[id]/page.tsx`) and the Soroban `get_attestation` contract call. Per the README's Attestation & Trust Layer section, this is what lets an unauthenticated responder trust a "verified" badge without calling the issuing facility — it is a correctness- and availability-critical path, not a decorative feature.

The module currently has three independent, verifiable defects that compound:

1. **The caching wrapper is unsafe outside a full Next.js request context.** `getAttestation` calls `unstable_cache(...)` *inside itself, on every invocation* (`lib/stellar/attestation.ts:137-144`), rather than constructing the wrapped function once at module scope. Running `tests/stellar-attestation.test.ts` reproduces a hard failure: `Error: Invariant: incrementalCache missing in unstable_cache`. This is not a test-only artifact — it means any call path that reaches `getAttestation` outside of a fully-initialized Next.js request/render context (edge middleware, a future Route Handler variant, a background job, a script) throws instead of degrading.
2. **The resilience contract is fully specified by tests but not implemented.** `lib/stellar/attestation.test.ts` imports `CircuitBreaker`, `attestationBreaker`, and `sorobanClient` from `./attestation` and asserts: a 3-state circuit breaker (CLOSED/OPEN/HALF-OPEN) that trips after 3 consecutive failures, a 30-second cooldown before HALF-OPEN, fast-fail (`<100ms`) while OPEN, and a hard timeout keyed on the exported `ATTESTATION_TIMEOUT_MS` (2000ms) that rejects a hung RPC call with `"Attestation RPC timeout"` and counts as a breaker failure. None of `CircuitBreaker`, `attestationBreaker`, or `sorobanClient` exist in the current file. `ATTESTATION_TIMEOUT_MS` is exported but never referenced anywhere in the file's control flow. Running the suite proves this: every test in `lib/stellar/attestation.test.ts` fails with `TypeError: Cannot read properties of undefined (reading 'reset')` or equivalent.
3. **`decodeAttestation` silently drops `revoked` and `expiry`.** `lib/attestation/types.ts` models `Attestation` with optional `expiry` and `revoked` fields, and `lib/attestation/recordHash.ts`'s `validateAttestation` branches on `att.revoked` and `att.expiry`. But `decodeAttestation` (`lib/stellar/attestation.ts:159-177`) only ever extracts `attester` and `timestamp` from the decoded SCVal — `revoked` and `expiry` are never read off `raw`, so they are always `undefined` regardless of what the contract actually returns. Revocation and expiry are therefore inert: a health worker revoking an attestation on-chain would have zero effect on the card's "verified" badge.

## Problem statement
Replace the attestation lookup layer with one that (a) caches correctly and does not throw outside a full request context, (b) enforces a hard timeout and a circuit breaker around the Soroban RPC call so a hanging or degraded RPC endpoint cannot block the public card page's render past a bounded latency, and (c) fully and correctly decodes every field of the on-chain `Attestation` struct, including optional `revoked` (bool) and `expiry` (u64) fields, however the Stellar SDK represents Soroban `Option<T>` values in `scValToNative` output (which may be `undefined`, `null`, or a nested variant tag depending on SDK version — you must determine and handle the actual representation, not assume one).

The circuit breaker must provide real protection in the project's actual deployment target: Vercel serverless functions, where a module-level singleton's in-memory state is **not** guaranteed to be shared across concurrent invocations or to survive between them (each invocation may land on a different warm/cold instance). A circuit breaker that only protects a single warm instance is materially weaker than what the docstrings and tests imply ("protects card-page latency during outages") — you must either (a) design a mechanism that provides meaningful protection across instances, or (b) explicitly document and justify why a per-instance breaker is an acceptable tradeoff here, backed by reasoning about Vercel's actual concurrency model and instance reuse behavior. This is a judgment call the issue deliberately leaves open — defend your choice in the PR description.

## Current behavior
- `lib/stellar/attestation.ts:134-147` — `getAttestation` constructs a new `unstable_cache`-wrapped function on every call.
- `lib/stellar/attestation.ts:159-177` — `decodeAttestation` extracts only `attester` and `timestamp`; `revoked`/`expiry` are never read.
- `lib/stellar/attestation.ts:55` — `ATTESTATION_TIMEOUT_MS` is exported but has zero readers in the file.
- No `CircuitBreaker` class, `attestationBreaker` instance, or `sorobanClient` object exists anywhere in `lib/stellar/`.
- `npx vitest run tests/stellar-attestation.test.ts` currently fails 3 of 4 tests with the `incrementalCache missing` invariant error.
- `npx vitest run lib/stellar/attestation.test.ts` currently fails all 7 tests (`CircuitBreaker` suite + `getAttestation` suite) because the imported names are `undefined`.
- `lib/attestation/recordHash.ts`'s `validateAttestation` (once its own syntax is fixed — see the separate, unrelated build-breakage cleanup) checks `att.revoked` and `att.expiry`, both of which can never be truthy today.

## Required behavior
- `getAttestation(recordHash)` must build its cache wrapper once (module scope), not per call, and must not throw when the Next.js incremental cache context is unavailable — it must fall back to an uncached (or process-local memoized) call in that case rather than crashing the caller.
- A hung or slow Soroban RPC call must reject within `ATTESTATION_TIMEOUT_MS` of being issued, with an error whose message is exactly `"Attestation RPC timeout"`, and this must count as a failure toward circuit-breaker tripping.
- After 3 consecutive failures (timeouts or RPC errors) for calls routed through the breaker, subsequent calls must fast-fail (reject in well under 100ms, no RPC attempt) until a cooldown period elapses, after which exactly one trial call is allowed (HALF-OPEN); success closes the breaker, failure re-opens it.
- The public card page (`app/(public)/card/[id]/page.tsx`) must continue to render full emergency data with a "verification status unavailable" state on any attestation-layer failure (timeout, breaker-open, RPC error) — this contract already exists and must not regress.
- `decodeAttestation` must correctly extract `revoked: boolean | undefined` and `expiry: number | undefined` from the contract's actual SCVal encoding of `Option<bool>` and `Option<u64>`, verified against the real `@stellar/stellar-sdk`'s `scValToNative` behavior (write a small script or unit test against the actual SDK, not just the test file's simplified mock, to confirm the true shape before relying on it).
- `validateAttestation` in `lib/attestation/recordHash.ts` must now meaningfully reject revoked or expired attestations once decoding is fixed.

## Constraints
- Do not change the public signature of `getAttestation(recordHash: string): Promise<Attestation | null>` — all existing callers (`page.tsx`, `route.ts`, `recordHash.ts`) must keep working unmodified.
- No new heavyweight dependency (no Redis, no external queue) may be introduced purely to make the circuit breaker distributed unless you can justify it fits within this project's current zero-infra-beyond-Supabase deployment model; a well-reasoned per-instance design is an acceptable outcome if justified.
- Must not regress the existing passing behavior of `tests/stellar-attestation-mock.test.ts` (local-dev fallback with no `ATTESTATION_CONTRACT_ID`) — the mock path must remain fast and must never touch the SDK.
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] `npx vitest run lib/stellar/attestation.test.ts` passes in full (all `CircuitBreaker` and `getAttestation` tests), without modifying the test file's assertions.
- [ ] `npx vitest run tests/stellar-attestation.test.ts` passes in full, without the `incrementalCache missing` error.
- [ ] `npx vitest run tests/stellar-attestation-mock.test.ts` continues to pass.
- [ ] A new adversarial test proves `decodeAttestation` correctly returns `revoked: true` and a numeric `expiry` when the (mocked, SDK-shape-accurate) simulation result encodes them, and that `validateAttestation` then returns `false` for a revoked or expired record hash.
- [ ] A new test proves that when the breaker is OPEN, `getAttestation` rejects in under 100ms with no attempt to reach the RPC server.
- [ ] A new test proves that calling `getAttestation` in an environment where `unstable_cache`'s incremental cache context is absent does not throw, and still returns a correct result.
- [ ] `npm run typecheck` and `npm run build` pass.
- [ ] PR description documents and justifies the chosen circuit-breaker deployment model (per-instance vs. distributed) with explicit reasoning about Vercel's concurrency/instance-reuse behavior.

## Out of scope
- The Soroban contract itself (`lafiya-contracts`, a separate repo) — do not change the on-chain `Attestation` struct or `get_attestation` semantics.
- Cache invalidation via `revalidateTag` on a "new attestation recorded" signal (tracked separately in the code as a follow-up; do not build an event-listener here — see the CHW payout listener issue in this batch for the related on-chain-event-consumption problem).
- The offline service-worker cache and card-ID-rotation cache-revocation problems (separate issues in this batch) — do not touch `app/public/sw.js`.
- Rewriting the record-hash computation itself (separate issue in this batch).

## Hints and references
- Stellar SDK docs on `scValToNative` and `nativeToScVal` for `Option<T>` encoding: Soroban represents `Option<T>` as a `ScVal` that is either `void`/`null` (None) or the wrapped value directly (Some) — but the exact native JS shape returned by `scValToNative` for a struct field typed `Option<u64>`/`Option<bool>` inside a larger struct needs direct verification against the installed `@stellar/stellar-sdk` version (`^16.0.1`), not assumption.
- Classic circuit-breaker state machine reference: Michael Nygard, *Release It!* (CLOSED/OPEN/HALF-OPEN pattern) — the test file's exact thresholds (3 failures, 30s cooldown) are the spec to satisfy.
- Next.js `unstable_cache` docs on cache-scope requirements and known limitations outside a request-scoped render (search Next.js issue tracker for "incrementalCache missing" for known constraints).
- Vercel's documentation on serverless function concurrency and instance reuse, to inform the per-instance-vs-distributed breaker design decision.
