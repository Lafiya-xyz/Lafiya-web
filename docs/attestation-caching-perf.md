# Attestation Cache — Performance Impact (Issue #17)

## Before

Every view of `/card/[id]` called `getAttestation(recordHash)`, which — once
the Soroban contract is configured — performs a live RPC `simulateTransaction`
call. N views of the same card = N RPC calls.

## After

`getAttestation` results are cached per `recordHash` via `unstable_cache`,
TTL configurable through `ATTESTATION_CACHE_TTL_SECONDS` (default 120s).
N repeat views of the same card within the TTL window = 1 RPC call.

## Configuration

Set `ATTESTATION_CACHE_TTL_SECONDS` in the environment to tune the tradeoff
between RPC load and staleness of the verified indicator.

## Expiry test coverage
`lib/stellar/attestation-caching.test.ts` verifies both halves of the TTL
contract described above, using a `next/cache` mock that models `revalidate`
(the earlier version of this mock cached forever and could not exercise
expiry at all):

- A lookup repeated before `ATTESTATION_CACHE_TTL_SECONDS` has elapsed is
  served from the cache — the underlying attestation fetch (via
  `attestationBreaker.execute`) runs only once.
- A lookup repeated after `ATTESTATION_CACHE_TTL_SECONDS` has elapsed
  triggers a second underlying fetch — a cached "verified" status is treated
  as stale and re-checked, never served indefinitely.
