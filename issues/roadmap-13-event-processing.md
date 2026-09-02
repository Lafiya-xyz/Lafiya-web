# [Spike] Evaluate queue-backed Soroban event processing for burst and outage recovery

## Category

Spike

## Question

Would a durable queue or batch ledger improve the CHW indexer’s ability to absorb event bursts and RPC interruptions compared with the current scheduled, cursor-based serverless runs?

## Context

The current `PayoutIndexer` processes bounded batches through `POST /api/internal/payout-indexer`, persists cursors in Supabase, and reconciles out-of-order observations. It intentionally has no external queue, while Soroban/Horizon outages and bursts remain operational risks.

## Why This Matters

The result determines whether the current zero-infrastructure architecture can support pilot and mainnet volume or whether backlog control needs a new processing layer.

## Areas to Investigate

- Current batch/cursor throughput and backlog behavior.
- Supabase-backed job tables, database queues, and managed queue alternatives.
- At-least-once delivery, idempotency, poison events, and dead-letter handling.
- RPC rate limits, retry backoff, and replay cost.
- Operational and financial cost at projected pilot/mainnet volumes.

## Evaluation Criteria

Reliability, throughput, recovery time, complexity, cost, observability, and compatibility with serverless deployment.

## Expected Deliverables

Load/backlog benchmark, architecture comparison, failure/replay model, recommended processing strategy, and a bounded proof of concept if the current design is insufficient.

## Acceptance Criteria

- [ ] Benchmarks use the existing indexer interfaces and representative event sizes.
- [ ] The analysis quantifies when the current scheduled model fails its proposed SLO.
- [ ] Queue alternatives define idempotency and poison-event handling.
- [ ] Recommendation includes migration and rollback considerations.

## Follow-Up Opportunities

Tune current batching or implement the selected queue, backpressure, and dead-letter workflow.

## Cross-Repository Impact

`lafiya-web` indexer; Stellar event sources; deployment infrastructure; future contract event volume.

## Complexity

Spike

## Impact

High

## Suggested Labels

`spike`, `indexer`, `scalability`, `stellar`, `operations`
