# Capacity model — national-scale rollout (10M cards)

Issue #886. `perf/capacity-model.mjs` is a parameterized end-to-end capacity
model: pure arithmetic over the assumptions in
[`perf/capacity-assumptions.json`](../perf/capacity-assumptions.json), no
network, no database, no secrets. It is reproducible from the repo:

```bash
npm run perf:capacity                       # 10M cards, default assumptions
node perf/capacity-model.mjs --cards=1000000
node perf/capacity-model.mjs --json         # machine-readable output
```

Any assumption can be overridden with `--<group>.<key>=<number>`, e.g.
`--traffic.dbBoundShare=0.5`. Unknown keys fail loudly (exit 1) so a typo
cannot silently produce a wrong model.

## What the model covers

| Area        | Derived quantity                                                       |
| ----------- | ---------------------------------------------------------------------- |
| DB size     | profile + audit + attachment bytes, year 1 and year 3 (growth applied) |
| Connections | peak RPS → DB-bound RPS → concurrent requests → pooler connections     |
| RPC volume  | Stellar RPC calls/month and peak calls/second                          |
| SMS         | messages/month and USD/month                                           |
| Storage     | object-storage GB year 1 / year 3 and USD/month                        |
| Serverless  | invocations/month, GB-seconds, compute + egress USD/month              |

The report ends with a ranked bottleneck list: `projected / ceiling` per
resource, flagged `BREACH` when utilization ≥ 100 %.

## Assumptions and where they come from

All values are order-of-magnitude planning numbers, deliberately conservative
and easy to challenge. Change them in the JSON, not in the script.

| Assumption                              | Default | Rationale                                                                 |
| --------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `cards`                                 | 10M     | Issue target for national rollout.                                        |
| `population.activeShare`                | 0.35    | Share of issued cards that generate traffic in a given month.             |
| `traffic.requestsPerActiveCardPerDay`   | 1.5     | Card views + profile edits + notification reads per active card.          |
| `traffic.peakToAverageRatio`            | 4       | Diurnal peak (clinic hours) vs daily mean.                                |
| `traffic.dbBoundShare`                  | 0.25    | Share of requests that miss ISR/CDN and hit Postgres (see `docs/card-caching-strategy.md`). |
| `traffic.dbLatencySeconds`              | 0.05    | p95 RPC latency budget for the card read.                                 |
| `traffic.rpcShare`                      | 0.10    | Share of requests that touch Stellar RPC (attestation reads).             |
| `traffic.avgResponseBytes`              | 70 kB   | `docs/perf-budget.md` total-without-photo budget.                         |
| `db.bytesPerProfileRow`                 | 4 kB    | Profile + emergency contacts + tags, TOAST included.                      |
| `db.bytesPerAuditRow`                   | 512 B   | One audit/consent event.                                                  |
| `db.auditRowsPerCardMonth`              | 20      | Consent, access, and verification events per card per month.              |
| `db.bytesPerCardAttachment`             | 64 kB   | Card metadata, QR payload, wallet pass blobs.                             |
| `db.annualGrowthRate`                   | 0.40    | Year-over-year row growth (audit dominates).                              |
| `db.requestsPerConnection`              | 20      | Requests multiplexed per Supavisor server connection.                     |
| `db.poolerMaxConnections`               | 2000    | Pooler ceiling before Postgres saturates.                                 |
| `rpc.providerRequestsPerSecond`         | 100     | Typical managed RPC tier ceiling.                                         |
| `sms.messagesPerActiveCardPerMonth`     | 0.5     | OTP + notification fallbacks.                                             |
| `sms.onboardingMessagesPerCard`         | 2       | Signup + first-login OTP per issued card.                                 |
| `sms.costPerMessageUsd`                 | 0.035   | Nigerian A2P rate.                                                        |
| `sms.monthlyBudgetUsd`                  | 250k    | Planning ceiling.                                                         |
| `storage.bytesPerCardYear1`             | 256 kB  | Photo (40 kB target) + exports + wallet assets.                           |
| `storage.annualGrowthRate`              | 0.50    | Export history growth.                                                    |
| `storage.quotaGb`                       | 5000    | Planning ceiling.                                                         |
| `storage.costPerGbMonthUsd`             | 0.021   | Object-storage list price.                                                |
| `serverless.avgDurationMs`              | 120     | Mean route handler duration.                                              |
| `serverless.memoryGb`                   | 1       | Function memory.                                                          |
| `serverless.costPerMillionInvocationsUsd` | 0.60  | Serverless invocation price.                                              |
| `serverless.costPerGbSecondUsd`         | 1.67e-5 | Serverless GB-second price.                                               |
| `serverless.costPerGbEgressUsd`         | 0.15    | CDN/egress price.                                                         |
| `serverless.monthlyBudgetUsd`           | 50k     | Planning ceiling.                                                         |

## Top bottlenecks and proposed mitigation issues

Ranked by utilization at 10M cards with the defaults above. Each row is a
candidate follow-up issue; file them with the label `scalability`.

1. **Postgres pooler connections** — DB-bound RPS × latency exceeds the pooler
   ceiling. Mitigation: raise Supavisor pool size, add read replicas for the
   public card RPC, and push the DB-bound share down with edge caching
   (`docs/card-caching-strategy.md`).
2. **Stellar RPC throughput** — peak attestation reads exceed the managed RPC
   tier. Mitigation: read-through cache for attestation lookups, batched reads,
   dedicated RPC tier with a fallback provider.
3. **SMS spend** — OTP volume at national scale dominates the run rate.
   Mitigation: WhatsApp/USSD fallback, shorter message bodies, volume pricing.
4. **Object storage footprint** — year-3 photo/export growth approaches the
   quota. Mitigation: lifecycle-expire superseded photos, cold-tier exports.
5. **Serverless + egress spend** — invocation count and payload size drive
   cost. Mitigation: serve the public card from ISR/CDN, keep responses inside
   the `docs/perf-budget.md` budget, move batch work to scheduled workers.

## Validating the top bottleneck

The model's top bottleneck is DB-bound latency under connection saturation.
It is validated with the existing k6 harness, which already samples
`pg_stat_activity` connection counts:

```bash
supabase start && supabase db reset
psql "$DB_URL" -f supabase/seed_loadtest.sql
BASE_URL=http://localhost:3000 \
  CONCURRENCY=500 DURATION=2m CARD_POOL_SIZE=500 \
  k6 run --summary-export=loadtest/summary.json \
  loadtest/k6_get_emergency_card_test.js
```

`CARD_POOL_SIZE` caps the cache-miss fan-out to the seeded pool so the run
reproduces the model's distinct-card concurrency. Compare the observed
`cache_miss_duration` p95 and `pg_connections` max against the model's
`connections.poolerConnections`; a p95 above the 1500 ms threshold in the k6
`thresholds` block while `pg_connections` is pinned at the ceiling confirms
the bottleneck. Record the run in `loadtest/results/` (git-ignored) and link
it from the follow-up issue.

## Reproducibility notes

- The model is deterministic: same assumptions in, same numbers out.
- No PHI, capability tokens, or secrets are read or emitted.
- `--json` output is stable enough to diff between assumption revisions.
