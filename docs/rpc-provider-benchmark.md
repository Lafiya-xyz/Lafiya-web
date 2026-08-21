# Soroban RPC & Horizon provider benchmark — spike outcome

- **Issue:** `issues/roadmap-10-rpc-provider-benchmark.md`
- **Date:** 2026-08-20
- **Harness:** `bench/rpc-provider-benchmark/harness.mjs` · baseline results in `bench/rpc-provider-benchmark/results/2026-08-20-baseline.json`

## TL;DR

1. **Stellar RPC is the strategic API, Horizon is on the way out.** Horizon is
   "nearing end-of-life" and won't get new features; SDF-hosted Horizon is
   truncated to 1 year of history. The payout indexer's Horizon dependency is
   the biggest architectural risk in scope.
2. **SDF runs no public *mainnet* RPC** — only testnet/futurenet. Production
   mainnet reads must come from a third-party provider or self-hosting.
3. Measured from this environment, **`sorobanrpc.com` (mainnet) and Gateway
   (mainnet) are the best public RPCs**; Gateway is fastest but its free tier
   rate-limits under sustained load. Several listed public endpoints
   (Nodies, OnFinality free, Liquify) were **unusable** during the run
   (403/500/429/stale).
4. **Mainnet Soroban contract state is archived** — `symbol()` on the native
   SAC returns `HostError: Storage, MissingValue` on *every* mainnet provider.
   This is an on-chain state outcome, not a provider defect, and it has a
   direct false-negative risk for the attestation read path (see Rollout risks).
5. **"RPC Archive" endpoints keep only ~64 live ledgers** in their realtime
   window (`lightsail-archive-mainnet` measured `ledgerRetentionWindow = 64`).
   They are for `getLedgers` full-history, **not** for `getTransactions` /
   `getEvents` / `simulateTransaction` — do not use them as a primary.

---

## 1. Key platform facts (source: developers.stellar.org, fetched 2026-08-20)

- **Stellar RPC** (renamed from Soroban RPC, Nov 2024) is the recommended
  realtime API: smart contracts, `simulateTransaction`, `getTransactions`,
  `getEvents`, `sendTransaction`. It keeps a **bounded ~7-day ledger window**
  (default `120960` ledgers, inspectable via `getHealth`). It is explicitly
  *not* an indexer.
- **Horizon** is **nearing end-of-life**; it keeps receiving protocol-compat
  updates but no new features. SDF's public Horizon history was truncated to
  **1 year** on 2024-08-01.
- **Mainnet RPC:** SDF operates `soroban-testnet.stellar.org` and
  `rpc-futurenet.stellar.org` only. Mainnet RPC is **third-party only**
  (or self-hosted).
- **Rate limits:** Horizon defaults to **3600 req/hour/IP** (configurable,
  429 on exceed; each stream update counts). RPC providers impose their own
  limits (observed as 429s; see §4).
- **`getEvents` caveat:** classic CAP-67 asset events require the backing
  Stellar Core to run `EMIT_CLASSIC_EVENTS=true` (and
  `BACKFILL_STELLAR_ASSET_EVENTS=true` for pre-Protocol-23 history). Confirm
  with any provider before relying on it.

## 2. Provider comparison matrix

Legend: ✅ supported · ❌ not offered · ⚠️ caveat · `?` verify before use.

### Soroban RPC providers (from the official provider list)

| Provider | Testnet | Mainnet | Dedicated | RPC Archive | Notes |
| --- | --- | --- | --- | --- | --- |
| SDF | ✅ | ❌ | — | ❌ | testnet/futurenet only; no mainnet |
| Validation Cloud | ✅ | ✅ | ✅ | ✅ | full-history + archive |
| Gateway | ✅ | ✅ | ✅ | ✅ | fastest measured; free tier throttles |
| Blockdaemon | ✅ | ✅ | ✅ | ❌ | enterprise, full-history Horizon too |
| QuickNode | ✅ | ✅ | ✅ | ❌ | global, SLA |
| Alchemy | ✅ | ✅ | ✅ | ❌ | |
| NowNodes | ✅ | ✅ | ✅ | ❌ | |
| Infstones | ❌ | ✅ | ✅ | ❌ | mainnet only |
| Obsrvr | ✅ | ✅ | ❌ | ✅ | |
| Ankr | ✅ | ✅ | ❌ | ✅ | public endpoint is full-archive; slow realtime |
| OnFinality | ❌ | ✅ | ✅ | ✅ | free public endpoint heavily 429'd in run |
| Lightsail (Quasar) | ❌ | ✅ | ❌ | ✅ | fast; archive endpoint has 64-ledger live window |
| Exaion | ❌ | ✅ | ✅ | ✅ | |
| GetBlock | ❌ | ✅ | ✅ | ✅ | |
| Nodies | ✅ | ✅ | ❌ | ❌ | public endpoints down/blocked during run |
| Uniblock | ✅ | ✅ | ❌ | ❌ | |
| Liquify | ✅ | ✅ | ❌ | ❌ | testnet RPC stale during run |

### Horizon providers

| Provider | Testnet | Mainnet | Full history | Notes |
| --- | --- | --- | --- | --- |
| SDF (`horizon.stellar.org`) | ✅ | ✅ | ❌ (1 year) | EOL trajectory |
| Blockdaemon | ✅ | ✅ | ✅ | |
| Validation Cloud | ✅ | ✅ | ✅ | |
| QuickNode | ✅ | ✅ | ❌ | |
| Ankr | ✅ | ✅ | ❌ | |
| Obsrvr | ✅ | ✅ | ❌ | |
| Nodies | ✅ | ✅ | ❌ | |
| LOBSTR (`horizon.stellar.lobstr.co`) | ❌ | ✅ | ❌ | public; fast root, slower data paths in run |

## 3. Benchmark methodology

- **Representative queries** — see the probe table in
  `bench/rpc-provider-benchmark/README.md`. `simulateTransaction` mirrors the
  `get_attestation` read; `getTransactions`/`getEvents` mirror the indexer;
  Horizon `forAccount payments` + `transaction by hash` mirror
  `HorizonPayoutSource`.
- **No patient data** — random synthetic keys + public chain data only.
- **Failure/throttling separated from latency** — every non-2xx / JSON-RPC
  error / timeout is bucketed (`http_429_throttled`, `http_5xx_server`,
  `rpc_error`, `network_error`, `timeout`) and excluded from the latency
  percentiles. `simulateTransaction` host errors are kept in the latency
  samples because the RPC round-trip succeeded.
- **Origin caveat** — this baseline ran from a datacenter host, **not from a
  Nigerian endpoint**. Treat absolute numbers as indicative. Re-run the
  harness from a Lagos/`africa-south1`/`af-south-1` VM for regional SLOs; the
  failover thresholds below are ratio-to-baseline so they transfer.

### Latency (p50 / p95 ms, 10 samples/probe, 5 s timeout)

| Provider (network) | health | getLatest | getTransactions | getEvents | simulate | availability |
| --- | --- | --- | --- | --- | --- | --- |
| sdf-testnet | 91/95 | 353/364 | 714/741 | 252/267 | 100/141 | 60/60 ok |
| sdf-futurenet | 91/93 | 91/92 | 133/456 | 93/200 | 99/103 | 60/60 ok |
| sorobanrpc.com (mainnet) | 53/78 | 451/533 | 349/384 | 131/146 | 68/137 | 60/60 ok |
| gateway (mainnet) | 9/49 | 74/135 | 51/57 | 12/13 | 19/21 | 60/60 ok |
| gateway (testnet) | 15/71 | 33/57 | 429-throttled | 429-throttled | 26/45 | throttled on 2 probes |
| lightsail (mainnet) | 48/66 | 130/365 | 116/150 | 52/60 | 70/110 | 59/60 ok |
| lightsail archive (mainnet) | 49/315 | 141/354 | 429-throttled | 429-throttled | 0/10 | live window = 64 ledgers |
| ankr (mainnet) | 158/287 | 1283/1443 | 972/1193 | 182/647 | 224/2225 | 60/60 ok but slow |
| onfinality (mainnet) | 429 | 429 | 429 | 429 | 429 | free endpoint unusable |
| nodies (testnet/mainnet) | 403 / 500 | — | — | — | — | down/blocked |
| liquify (testnet) | rpc-error | 12/15 | rpc-error | rpc-error | 6/7 | stale (health: 3029 h behind) |

### Horizon latency (p50 / p95 ms)

| Provider (network) | root | accountPayments | txByHash | availability |
| --- | --- | --- | --- | --- |
| sdf-horizon (testnet) | 79/80 | 100/109 | 81/92 | 40/40 ok |
| sdf-horizon (mainnet) | 79/80 | 100/1266 | 81/86 | 40/40 ok |
| lobstr-horizon (mainnet) | 35/46 | 816/1112 | 191/294 | 40/40 ok |

## 4. Findings & caveats

1. **Mainnet state archival is a contract-level hazard, not provider noise.**
   `simulateTransaction` of `symbol()` returned `HostError: Error(Storage,
   MissingValue)` on **all** mainnet providers. Read-only contract calls can
   fail when the contract instance's storage TTL lapses; the caller must be
   prepared to `restore` before reading. See Rollout risks.
2. **"Archive" ≠ realtime.** `lightsail-archive-mainnet` reports
   `ledgerRetentionWindow = 64`, so `getTransactions`/`getEvents` can't page
   normally. Use archive endpoints only for `getLedgers` backfills.
3. **Free public RPCs throttle unpredictably.** Gateway's free tier is the
   fastest measured but 429'd on heavier probes; OnFinality free was unusable;
   Nodies public endpoints were 403/500. Free endpoints are fine for dev, not
   for an emergency-latency production path.
4. **SDF testnet `getTransactions` is the slowest probe in the set** (p95
   ~741 ms) — fine for testnet, but reinforces that production must have a
   dedicated/paid mainnet endpoint.
5. **Horizon EOL.** `HorizonPayoutSource` depends on
   `payments().forAccount(...)` + an N+1 `transaction()` fetch. This works
   today (p95 ~1.3 s on SDF mainnet) but is a dead-end API. Migrate to RPC
   `getTransactions`/`getEvents` (the attestation source already uses
   `getTransactions`).

## 5. Recommendation

### 5.1 Attestation (public-card verification) — read path

- **Primary (mainnet):** a dedicated/paid Stellar RPC with an SLA and
  full realtime methods. Candidates in priority order: **Validation Cloud** or
  **Blockdaemon** (full-history + archive + dedicated), **Gateway** or
  **QuickNode/Alchemy** (dedicated). If starting on a free endpoint, use
  **`sorobanrpc.com` (mainnet.sorobanrpc.com)** — the most consistently
  available public mainnet RPC in the run.
- **Fallback:** a second provider from a *different operator* (so one org's
  outage/blast radius doesn't take both out). Gateway and sorobanrpc.com are
  independent operators.
- Keep the existing per-instance breaker (`ATTESTATION_TIMEOUT_MS=2000`,
  3 failures / 30 s cooldown) as the last line of defense; add a thin
  provider selector in front of it.

### 5.2 Payout indexer — event path

- **Migrate off Horizon to RPC** (`getTransactions`, parsing payment ops from
  `resultMetaXdr`/envelope, exactly like `SorobanAttestationSource` already
  does). Use `getEvents` only after confirming the provider emits CAP-67
  classic events; otherwise `getTransactions` is the safe default.
- Use a provider with the **full ~7-day realtime window** (not an archive
  endpoint). Keep the existing idempotent, cursor-based store so a failover
  never double-applies.

### 5.3 When to fail over

Fail over from primary → fallback when **any** of these hold for the primary,
observed from the app's own region:

- ≥ 3 consecutive failures (matches the existing breaker), **or**
- error/throttle rate ≥ 10% over a 30 s window, **or**
- sustained 429/5xx, **or**
- p95 latency > 2× the region's own baseline for ≥ 1 minute.

Do **not** fail over on a single timeout or a single slow sample. Probe
`getHealth` every 30 s and treat `ledgerRetentionWindow`/`oldestLedger`
degradation as an early signal (especially for archive-backed endpoints).

### 5.4 Avoiding inconsistent decisions

- Both RPC and Horizon are **read-only views of one chain**, so "disagreement"
  is **replication/tip lag**, not divergent state — which simplifies the
  problem. There is no cross-provider write path.
- **Pin a single provider per decision.** One request (or one indexer run)
  reads from exactly one provider; never merge two providers' responses into
  one verdict.
- **Indexer:** only advance the cursor after a page whose provider-reported
  `latestLedger` covers the page's max ledger; treat a provider whose tip is
  behind the cursor as "not ready" rather than "empty". The idempotent store
  (keyed by tx hash + paging token) makes re-reading safe.
- **Attestation:** the 120 s cache already absorbs transient staleness; a
  failover can only change "verified" vs "unavailable", and the page already
  renders a graceful "unavailable" state. Document that the *archival*
  false-negative (below) must be fixed independently — no provider swap
  resolves it.

## 6. Rollout risks

1. **Archived-state false negative (high).** If the attestation registry's
   instance storage lapses, `simulateTransaction` returns a non-success result
   and `attestation.ts` currently maps that to `null` → the card shows **"not
   verified"** (a false negative) instead of "unavailable". Fix: distinguish
   `Storage, MissingValue` (trigger `restorePreamble`/`restoreFootprint`, or
   surface "unavailable") from a genuine `get_attestation` revert.
2. **Free-endpoint throttling (high for dev, medium for prod).** The fastest
   public endpoints 429 under load; ensure prod uses a paid/dedicated plan or
   self-host.
3. **Horizon EOL (high, scheduled).** Do the payout-source migration before
   Horizon deprecation; don't build new features on Horizon.
4. **Archive endpoint confusion (medium).** Misusing an archive RPC as primary
   yields a 64-ledger realtime window and broken paging.
5. **Regional latency unknown (medium).** This baseline is not a Nigerian
   measurement. Run the harness from the target region and tune thresholds
   against that baseline before committing to an SLO.
6. **Provider/contract network pairing (medium).** `SOROBAN_RPC_URL`,
   `STELLAR_HORIZON_URL`, passphrase, and `ATTESTATION_CONTRACT_ID` must all
   point at the same network; validate at startup (see
   `issues/roadmap-06-production-config-validation.md`).
7. **`getEvents` feature parity (medium).** CAP-67 classic events depend on
   provider config; verify before relying on `getEvents` for the payout path.

## 7. Acceptance criteria

- ✅ Representative attestation (`simulateTransaction`) and event
  (`getTransactions`/`getEvents`/Horizon payments) queries are measured.
- ✅ Failure and throttling behavior is recorded separately
  (`http_429_throttled`, `http_5xx_server`, `rpc_error`, `network_error`,
  `timeout`) and excluded from latency percentiles.
- ✅ Failover policy + consistency rules defined (§5.3, §5.4).
- ✅ No patient data used (synthetic keys + public chain data only).

## 8. Follow-ups (if justified)

1. Implement the provider abstraction + health-based failover + provider alerting
   (the "Follow-Up Opportunities" on the issue).
2. Migrate `HorizonPayoutSource` to Stellar RPC and delete the Horizon
   dependency.
3. Fix the archived-state false negative in `attestation.ts`.
4. Re-run the harness from a Nigerian/`africa-south1` endpoint and codify the
   regional SLO thresholds.
