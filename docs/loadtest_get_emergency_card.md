# Load Testing — Public Emergency Card (`/card/[id]`)

## Overview

This harness measures the latency and error rate of the **public emergency card
page** (`app/(public)/card/[id]`) under concurrent load. It is the single most
latency-critical page in Lafiya — a first responder scanning a QR code in the
field must see a patient's blood group, genotype, and drug allergies within
seconds, even on a 2G/EDGE connection (see `docs/perf-budget.md`).

The harness exercises **two distinct load profiles** because the page uses
Next.js ISR (`revalidate = 60`), which means repeated requests to the same
card ID are served from cache while requests to distinct card IDs require a
Supabase RPC round-trip:

| Scenario       | What it measures                                    |
| -------------- | --------------------------------------------------- |
| **cache_hit**  | All VUs hit the **same** card ID — ISR-cached HTML  |
| **cache_miss** | VUs fan across **500 distinct** card IDs — DB-bound |

## Prerequisites

- **Node.js 24+** and **npm** (to build the Next.js app)
- **Supabase CLI** (`supabase start` must work)
- **k6** (https://k6.io/docs/get-started/installation/)
- **psql** (PostgreSQL client, for the seed script)

## Step 1 — Seed the database

```bash
# Start a local Supabase instance and reset to a clean state.
supabase start
supabase db reset

# Get the local DB URL.
DB_URL=$(supabase status --output json | jq -r '.DB_URL')

# Seed 500 load-test profiles (creates auth.users + profiles).
psql "$DB_URL" -f supabase/seed_loadtest.sql
```

### Why 500 rows?

500 profiles represents a realistic near-term pilot deployment for a local
health district. It is large enough to overwhelm the ISR cache (revalidate =
60 s) when k6 fans requests across distinct card IDs — with 50 concurrent VUs
each making a request every ~0.75 s, ~67 requests/second spread across 500
cards means most cards are only hit once within any 60 s window, forcing a
database round-trip. A smaller dataset (e.g. 50) would not stress the
database path because ISR would cache most responses within the first few
seconds.

The seed script also exports the generated `card_public_id` values to
`loadtest/card_ids.txt` for the k6 script.

## Step 2 — Build and start the app

```bash
npm run build
npm run start &
# Wait for the server to be ready:
npx wait-on --timeout 60000 http://localhost:3000
```

## Step 3 — Run the load test

```bash
BASE_URL=http://localhost:3000 \
  CONCURRENCY=50 \
  DURATION=1m \
  k6 run --summary-export=loadtest/summary.json \
    loadtest/k6_get_emergency_card_test.js
```

### Environment variables

| Variable      | Default | Description                        |
| ------------- | ------- | ---------------------------------- |
| `BASE_URL`    | —       | Origin of the running Next.js app  |
| `CONCURRENCY` | `50`    | Target VUs per scenario            |
| `DURATION`    | `1m`    | Steady-state duration per scenario |

## SLO Targets (Concurrency / Latency)

These are the **service-level objectives** for the `/card/[id]` route under
load. They are designed to ensure the page remains usable for a field
responder even when multiple responders are scanning cards simultaneously.

### Cache-hit scenario (ISR-served)

| Metric | Target   | Rationale                                          |
| ------ | -------- | -------------------------------------------------- |
| p50    | < 200 ms | Cached HTML should be near-instant from localhost  |
| p95    | < 500 ms | Allows for occasional GC pauses / ISR revalidation |
| p99    | < 800 ms | Hard ceiling — anything above indicates contention |
| Errors | < 1 %    | No functional errors when serving cached content   |

### Cache-miss scenario (DB-bound)

| Metric | Target    | Rationale                                               |
| ------ | --------- | ------------------------------------------------------- |
| p50    | < 500 ms  | Supabase RPC + SSR for a single-row lookup              |
| p95    | < 1500 ms | Matches the perf-budget's 5 s EDGE target minus network |
| p99    | < 2500 ms | Hard ceiling for server-side processing time            |
| Errors | < 1 %     | DB query failures should be extremely rare locally      |

### Target concurrency

**50 concurrent VUs** per scenario. Rationale: a single health district pilot
with 500 registered patients is unlikely to see more than 50 simultaneous card
scans at any moment (e.g. a mass-casualty incident at peak). This target is
intentionally conservative — it should be revised upward as deployment scales
beyond pilot.

## Methodology — Distinguishing Regression from Noise

Single-run p95 thresholds are noisy. A 10 % swing between runs is normal due
to GC pauses, background processes, and ISR timing. This section documents
how to determine whether a change in latency is a **real regression** or
ordinary run-to-run variance.

### Approach: baseline + standard-deviation threshold

1. **Establish a baseline**: run the harness **N ≥ 5** times under identical
   conditions (same machine, same CONCURRENCY, same DURATION, same seed data).
   Record the p95 of each run for both scenarios.

2. **Compute baseline statistics**: for each scenario, compute:
   - `μ` = mean of the N p95 values
   - `σ` = standard deviation of the N p95 values

3. **Regression threshold**: a new run's p95 is flagged as a regression if:

   ```
   p95_new > μ + 3σ
   ```

   With N ≥ 5 and a 3σ threshold, the false-positive rate is < 1 % under
   a normal distribution — conservative enough for CI.

4. **Minimum-N rule**: do **not** flag a regression until at least 5 baseline
   runs exist. Before that, only the absolute SLO thresholds (in the k6
   `thresholds` config) are enforced.

### Worked example

Suppose 5 baseline runs of the cache-miss scenario produce p95 values (ms):

| Run | p95 (ms) |
| --- | -------- |
| 1   | 1120     |
| 2   | 1085     |
| 3   | 1190     |
| 4   | 1050     |
| 5   | 1145     |

- μ = 1118 ms
- σ = 52.7 ms
- Threshold = 1118 + 3 × 52.7 = **1276 ms**

A subsequent run producing p95 = 1300 ms would be flagged as a regression.
A run producing p95 = 1250 ms would pass (within 3σ of baseline).

### CI enforcement

The GitHub Actions workflow (`.github/workflows/loadtest-get-emergency-card.yml`)
enforces the **absolute SLO thresholds** defined in the k6 script's
`thresholds` block. k6 exits with a non-zero status code when any threshold
is breached, which fails the workflow.

For the **statistical regression detection** (3σ baseline comparison), the
workflow uploads `loadtest/summary.json` as an artifact. A future enhancement
can compare against historical artifacts to implement the baseline comparison
automatically. Until then, the absolute thresholds provide a safety net.

## Supabase Connection Pooler Analysis

Supabase's local development instance uses **direct Postgres connections**
(no PgBouncer), so connection pooling is not a factor in local load tests.

In production, Supabase uses **transaction-mode PgBouncer** as the default
connection pooler. Key considerations:

- **Free tier**: 60 direct connections, pooler provides ~200 effective
  connections through multiplexing.
- **Pro tier**: 60 direct + Supavisor pooling for higher concurrency.
- **At 50 VUs**: each k6 VU holds a connection only for the duration of the
  HTTP request (which triggers a single Supabase RPC call). With ~0.75 s
  think time between requests, the effective concurrent DB connections is
  ~50 × (response_time / (response_time + think_time)). At p50 = 500 ms
  response time and 750 ms think time, this is ~50 × 0.4 = **~20 concurrent
  DB connections** — well within both free and pro tier limits.
- **Bottleneck threshold**: connection pooling is unlikely to become a
  bottleneck before ~150 concurrent VUs on the free tier. The application
  layer (Next.js SSR) is the more likely bottleneck at that scale.
- **Recommendation**: no connection-pool-size tuning is required for the
  current 50-VU target. If scaling to > 100 VUs in production, switch to the
  pooled connection string (`pooler.supabase.com:6543`) and monitor
  `pgbouncer_active_connections` vs `pgbouncer_max_connections`.

## Caching Behavior and ISR Interaction

The card page uses `export const revalidate = 60` (ISR with 60 s TTL). This
means:

- **First request** to a given card ID triggers SSR + Supabase RPC (cold).
- **Subsequent requests** within 60 s serve the cached HTML (warm).
- After 60 s, the next request triggers a background revalidation while
  serving stale content (ISR revalidation).

This is why the harness **must** exercise both scenarios separately:

- **cache_hit** (all VUs → one card): after the first request, all subsequent
  requests are served from the ISR cache. This is the best-case latency and
  represents the common case where multiple responders scan the same patient's
  card.

- **cache_miss** (VUs → 500 cards): with 50 VUs making ~67 req/s across 500
  cards, each card is hit roughly once per 7.5 s — well within the 60 s TTL,
  so ISR caching does apply after the first hit. However, the **first hit**
  for each card is a full SSR + DB round-trip, and with 500 cards the harness
  measures a mix of cold and warm responses that reflects realistic production
  load better than a single-card benchmark.

A naive single-metric benchmark that averages both would understate cold-cache
latency and overstate cache-hit latency.

## Decision Log

| Decision                   | Value / Rationale                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Target concurrency**     | 50 VUs per scenario — conservative estimate for a single health district pilot (see rationale above) |
| **Cache-hit p95 SLO**      | < 500 ms — ISR-cached HTML should be near-instant                                                    |
| **Cache-miss p95 SLO**     | < 1500 ms — allows for Supabase RPC round-trip under load                                            |
| **Error rate SLO**         | < 1 % — functional errors should be near-zero                                                        |
| **Seed row count**         | 500 profiles — large enough to overwhelm ISR cache                                                   |
| **Regression method**      | 3σ above baseline mean (N ≥ 5 runs); absolute thresholds as safety net                               |
| **Run frequency (CI)**     | Weekly (Sunday 04:00 UTC) + manual dispatch                                                          |
| **Tool**                   | k6 — already established in the project; excellent threshold and custom metric support               |
| **Connection pool tuning** | Not required at 50 VUs; revisit at > 100 VUs                                                         |

## Out of Scope

- Changing `app/(public)/card/[id]/page.tsx`'s caching strategy — file a
  follow-up issue if load test results suggest the ISR TTL needs adjustment.
- Load-testing other routes (`/api/attestation/[recordHash]`, profile editor,
  avatar upload).
- Provisioning or tuning a production Supabase project's connection pool
  configuration — the analysis above informs that decision but does not
  implement it.
