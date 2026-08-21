# Soroban RPC / Horizon provider benchmark

Reproducible harness for the spike in `issues/roadmap-10-rpc-provider-benchmark.md`.
It measures the exact query shapes `lafiya-web` issues today plus the RPC methods a
Horizon→RPC migration would use, against every candidate provider, and records
**normal latency**, **failures**, and **throttling separately**.

Findings and the recommended primary/fallback policy live in
[`docs/rpc-provider-benchmark.md`](../../docs/rpc-provider-benchmark.md).

## What it measures

| Probe | Mirrors | Purpose |
| --- | --- | --- |
| RPC `getHealth` / `getLatestLedger` / `getNetwork` | health checks | availability + ledger retention |
| RPC `simulateTransaction` (native SAC `symbol`) | `lib/stellar/attestation.ts` `get_attestation` | public-card verification read |
| RPC `getTransactions` | `SorobanAttestationSource.read()` | payout indexer ledger paging |
| RPC `getEvents` | post-Horizon event query (CAP-67) | payout indexer event stream |
| Horizon `GET /` | load-balancer health probe | availability |
| Horizon `GET /accounts/{acct}/payments` | `HorizonPayoutSource.read()` | payout source |
| Horizon `GET /transactions/{hash}` | `operation.transaction()` N+1 | payout source |

## Why no patient data

- `simulateTransaction` uses a freshly generated random key and the well-known
  native Stellar Asset Contract (`symbol()` — a no-arg read).
- Horizon probes auto-discover the most recent **public** chain payment and
  query only public chain data. Nothing from `profiles`, `card_public_id`, or
  any user table is used.

## Run it

```bash
node bench/rpc-provider-benchmark/harness.mjs
node bench/rpc-provider-benchmark/harness.mjs --iterations 25 --timeout 6000 --out results/region-X.json
node bench/rpc-provider-benchmark/harness.mjs --only 'gateway|lightsail'
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--iterations` | `10` | samples per probe (raise for tighter p95/p99) |
| `--timeout` | `8000` | per-request timeout, ms |
| `--out` | none (stdout JSON) | write JSON report to a file |
| `--only` / `--skip` | none | regex filter on provider id |

Output is JSON: per-provider `retention` (from `getHealth`), per-probe
`p50/p95/p99/min/max/mean`, `ok/attempts`, and a `failures` breakdown keyed by
classification (`http_429_throttled`, `http_5xx_server`, `rpc_error`,
`network_error`, `timeout`, …). `simulateTransaction` additionally reports
`hostSuccess`/`hostError` — a host error (e.g. `Storage, MissingValue`) is a
contract-state outcome, not a provider failure, so it is kept in the latency
samples.

## Running from a target region

Latency here is from whatever machine runs the harness, so the committed
baseline is **indicative, not a Nigerian-mobile measurement**. To get real
regional numbers, run the harness from a VM in the deployment region (e.g.
Lagos, or GCP `africa-south1` / AWS `af-south-1`) and compare `--out` files.
Failover thresholds in the report are expressed relative to a region's own
baseline (ratio-to-baseline), so they hold across regions even where absolute
latency differs.
