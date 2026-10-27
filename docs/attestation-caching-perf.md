# Attestation Cache — Performance Impact (Issues #17, #792)

## Server-side cache (`getAttestation` — issue #17)

Every view of `/card/[id]` calls `getAttestation(recordHash)`, which — once
the Soroban contract is configured — performs a live RPC `simulateTransaction`
call. N views of the same card = N RPC calls without caching.

`getAttestation` results are cached per `recordHash` via `unstable_cache`,
TTL configurable through `ATTESTATION_CACHE_TTL_SECONDS` (default 120s).
N repeat views of the same card within the TTL window = 1 RPC call.

Set `ATTESTATION_CACHE_TTL_SECONDS` in the environment to tune the tradeoff
between RPC load and staleness of the verified indicator.

### Expiry test coverage
`lib/stellar/attestation-caching.test.ts` verifies both halves of the TTL
contract, using a `next/cache` mock that models `revalidate`:

- A lookup repeated before `ATTESTATION_CACHE_TTL_SECONDS` has elapsed is
  served from the cache — the underlying attestation fetch runs only once.
- A lookup repeated after `ATTESTATION_CACHE_TTL_SECONDS` has elapsed
  triggers a second underlying fetch — a cached "verified" status is treated
  as stale and re-checked, never served indefinitely.

---

## HTTP conditional requests and cache headers (issue #792)

`GET /api/attestation/[recordHash]` now returns explicit HTTP cache directives
and supports conditional requests so clients and intermediaries can avoid
redundant full round-trips.

### Headers returned on every 200 response

| Header | Value | Rationale |
|--------|-------|-----------|
| `ETag` | `"<32-char SHA-256 prefix>"` | Strong ETag derived from `verified` flag + ledger sequence + attester + timestamp. Changes whenever trust state or ledger changes. |
| `Cache-Control` | `private, max-age=60, stale-while-revalidate=30` | See freshness budget below. |
| `Vary` | `Accept-Encoding` | Separate cache entries for compressed vs. uncompressed responses. |

### Freshness budget

- **`max-age=60`** — the browser/private cache may reuse the response for up
  to 60 seconds without a revalidation request. A newly issued attestation
  becomes visible within ~1 minute.
- **`stale-while-revalidate=30`** — after `max-age`, the stale response may
  be served for a further 30 seconds while a background fetch runs. Safe here
  because attestations are append-only: a "not verified" result may briefly
  lag a new attestation, but a verified result can never revert to
  not-verified within the window.
- **`private`** — no CDN or shared-cache storage. Attestation state is
  user-visible trust information; different users must not share a cached
  response.

### Conditional request flow (If-None-Match → 304)

1. Client sends `GET /api/attestation/<hash>` → receives `200` with `ETag: "abc..."`.
2. Client caches the body and the ETag.
3. On the next request the client sends `If-None-Match: "abc..."`.
4. If the ETag matches the freshly-derived value, the route returns `304 Not
   Modified` with no body and **without calling the Soroban RPC**. The client
   reuses its cached body.
5. If the ETag differs (state changed), the route returns a fresh `200`.

The 304 path skips the RPC call entirely, reducing both latency and contract
simulation costs for frequently-polled hashes.

### CDN-cache poisoning mitigations

- `private` prevents any shared cache from storing the response.
- `Vary: Accept-Encoding` ensures a compressed response does not contaminate
  an uncompressed entry.
- The ETag is derived purely from response semantics (state + ledger), not
  from query parameters or request headers, so it cannot be poisoned by a
  crafted query string.
