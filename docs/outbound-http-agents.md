# Outbound HTTP agents (Issue #881)

Hot-path outbound calls go through named `undici` dispatchers defined in
`lib/http/dispatchers.ts` and used via `upstreamFetch(name, url, init)`.

| Upstream        | Callers                                   | `connections` | `keepAliveTimeout` / max | `connectTimeout` | headers / body timeout | `allowH2` |
| --------------- | ----------------------------------------- | ------------- | ------------------------ | ---------------- | ---------------------- | --------- |
| `soroban`       | `lib/stellar/attestation.ts` (card route) | 16            | 30 s / 120 s             | 1.5 s            | 2 s / 2 s              | yes       |
| `notifications` | Termii, Twilio SMS adapters               | 8             | 15 s / 60 s              | 5 s              | 10 s / 10 s            | yes       |

## Rationale

- **Keep-alive.** Node's default keep-alive is 4 s, so after a short lull the
  next card view pays DNS + TCP + TLS to the RPC region again. 30 s covers
  typical gaps between card views on a warm function instance. The 120 s
  maximum caps how long we trust a server-advertised keep-alive.
- **Bounded pools.** The default pool per origin is unbounded, so a burst can
  open one socket per in-flight request and exhaust file descriptors. 16
  sockets per Soroban origin is enough for singleflight-coalesced lookups
  (`attestationFlight`). Extra requests queue instead of opening new sockets.
  SMS traffic runs in the background outbox and needs fewer.
- **HTTP/2.** `allowH2` multiplexes requests over one connection when the
  provider negotiates h2 through ALPN, and falls back to HTTP/1.1 otherwise.
  `pipelining: 1` keeps HTTP/1.1 requests from blocking each other.
- **Timeouts.** The Soroban timeouts match `ATTESTATION_TIMEOUT_MS` (2 s), so a
  stuck socket is dropped at the same deadline the lookup enforces. Connect
  is capped lower (1.5 s) so a dead endpoint fails fast and trips the circuit
  breaker. Provider timeouts are looser because those calls are retried by
  the outbox.
- **Why undici's own `fetch`.** A dispatcher from the `undici` package only
  works with the `fetch` from the same undici version. Node 24's global
  `fetch` bundles undici 7, and it rejects an undici 8 `Agent` with
  `invalid onRequestStart method`. So `upstreamFetch` uses `undici.fetch`.

## Connection warming

There's no warming at function start. The card route is served from a data
cache (`unstable_cache`) plus singleflight, so most views make no RPC call,
and opening a TLS connection on every cold start would cost more than it
saves. Revisit this if traces show connect/TLS dominating cache-miss latency.

## Measuring

Use `bench/rpc-provider-benchmark` and the soak procedure in
`docs/soak-test.md`. Compare p95 attestation lookup latency and open-socket
counts (`ss -tan | grep -c ESTAB`) before and after, at 2× expected peak for
10 minutes. These numbers still need to be recorded from a staging run
against the live RPC. They can't be produced offline.
