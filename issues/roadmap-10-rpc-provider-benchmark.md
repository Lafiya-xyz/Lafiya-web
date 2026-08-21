# [Spike] Benchmark Soroban and Horizon provider resilience for Nigerian mobile traffic

## Outcome

Completed 2026-08-20. See [`docs/rpc-provider-benchmark.md`](../docs/rpc-provider-benchmark.md)
for the comparison matrix, benchmark results, recommended primary/fallback
policy, and rollout risks. Harness: `bench/rpc-provider-benchmark/`.

## Category

Spike

## Question

Which Soroban RPC and Horizon provider strategy gives acceptable latency and availability for public-card verification and payout indexing from the project’s target deployment regions?

## Context

The app uses configurable `SOROBAN_RPC_URL` and `STELLAR_HORIZON_URL`, with timeout/circuit-breaker protection for attestation and a durable indexer for payouts. There is no provider benchmark, failover policy, or measured regional SLO.

## Why This Matters

Provider choice affects emergency responder latency, outage behavior, operating cost, and whether a multi-provider gateway is necessary.

## Areas to Investigate

- Candidate Soroban RPC and Horizon providers and archival/retention guarantees.
- Latency, error rates, throttling, and rate limits from target regions.
- Failover consistency and behavior during provider disagreement.
- Contract simulation and event-query feature parity.

## Evaluation Criteria

P95/P99 latency, availability, error recovery, retention, cost, geographic reach, API compatibility, and operational burden.

## Expected Deliverables

Provider comparison matrix, reproducible benchmark harness/results, recommended primary/fallback policy, and rollout risks.

## Acceptance Criteria

- [x] Measurements use representative attestation and event queries.
- [x] Failure and throttling behavior is recorded separately from normal latency.
- [x] The recommendation defines when to fail over and how to avoid inconsistent decisions.
- [x] No patient data is used in the benchmark.

## Follow-Up Opportunities

Implement provider abstraction, health-based failover, and provider-specific alerting if justified.

## Cross-Repository Impact

`lafiya-web` RPC/indexer configuration; `lafiya-contracts` deployment network; future verifier service.

## Complexity

Spike

## Impact

High

## Suggested Labels

`spike`, `stellar`, `performance`, `reliability`

