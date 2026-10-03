# CHW Batch Payouts

Implements the "batch payments" issue: pay up to 100 CHWs per Stellar
transaction, and recover correctly when a transaction fails atomically.

## Why batching

Per-payment transactions multiply Horizon submission fees and cause sequence
number contention when the sponsor pool account pays many CHWs close
together. Stellar transactions support up to 100 operations per transaction,
so bundling `payment` operations amortizes the base fee and avoids most
sequence contention, at the cost of atomicity: **one bad recipient (bad
destination, unauthorized trustline, etc.) fails the whole transaction.**

## Design

Code: `lib/stellar/payout-indexer/batch-payout.ts`.

- `buildPayoutBatches(recipients, config)` — splits a list of
  `PayoutRecipient` (each tied to a `payout_obligations.id` and
  `eligibility_key`) into transactions of up to
  `maxOperationsPerTransaction` (configurable, capped at 100 — the Stellar
  protocol limit).
- Each transaction's memo is `Memo.hash` of a SHA-256 digest over the batch's
  obligation ids, so a submitted transaction can always be traced back to the
  exact obligation set it covers, even before individual payment operations
  are observed by the indexer.
- `bisectAndRetry(recipients, submit, quarantine)` — on a failed submission,
  splits the batch in half and resubmits each half. This repeats until a
  failing half is down to a single recipient, at which point that recipient
  is quarantined with the Horizon `op_*` result code as the reason, and every
  other recipient in the original batch is unblocked. This bounds the cost of
  a single bad recipient to `O(log2(batchSize))` extra submissions, and — per
  the acceptance criteria — never blocks the rest of the batch for more than
  one retry cycle (the recursive bisection *is* the one retry cycle from the
  caller's perspective: it runs to completion before returning).
- `submitBatchesSerially(...)` wires the above against a real
  `Horizon.Server`, extracting `result_codes.operations` from Horizon's
  `tx_failed` error shape.

## No double payment

Idempotency comes from two layers:

1. Each operation's underlying obligation carries `eligibility_key`
   (`payout_obligations.eligibility_key`, already unique in the schema). The
   existing `apply_chw_payout` RPC (see `lib/stellar/payout-indexer/store.ts`)
   is idempotent on this key, so re-observing the same payment twice (e.g.
   after a retried submission that actually succeeded on-chain but whose
   Horizon response was lost) does not double-credit an obligation.
2. `bisectAndRetry` never resubmits a recipient that was already reported
   `ok: true` by an inner batch — see the property test in
   `batch-payout.test.ts`, which asserts no recipient id appears twice across
   `retryable` and `quarantined` for randomized batch sizes (1-100) and
   randomized single failure positions.

## Sequence numbers

This iteration submits batches **serially** against a single sponsor source
account — documented here per the issue's "or document serial submission"
option. `BatchPayoutConfig.channelAccounts` is accepted so a future change
can fan out parallel submission across a pool of channel accounts (SEP-0010
style), but wiring that up is left out of scope for this change; serial
submission is safe and simple, and at 100 ops/tx the sponsor pool can already
clear a few thousand CHWs per minute serially.

## Settlement observation

This module intentionally does **not** mark `payout_obligations` as
`settled` based on a successful `submitTransaction` response. Settlement
truth still comes from `PayoutIndexer` / `HorizonPayoutSource`
(`lib/stellar/payout-indexer/indexer.ts`, `sources.ts`), which observe the
payment on ledger and reconcile it against `payout_obligations` the same way
single-payment submissions already do. This avoids trusting a submission
response that could be a false positive (e.g. a timeout where the tx
actually applied) or false negative.

## Testing

- `lib/stellar/payout-indexer/batch-payout.test.ts` — unit tests plus a
  property-style test (50 randomized trials, deterministic seeded PRNG, no
  new dependency) sweeping batch sizes 1-100 and random single-failure
  positions, asserting exactly one quarantine and no duplicate recipient IDs
  across `retryable`/`quarantined`.
- Not run as part of this change (per task constraints); a maintainer should
  run `npm run lint && npm run typecheck && npm test` before merge, and a
  testnet dry run against the SDF Horizon test instance before enabling this
  path in the cron-triggered payout endpoint.

## Out of scope

Cross-asset payouts, channel-account wiring, and the API/cron endpoint that
would call `buildPayoutBatches`/`submitBatchesSerially` in production are
left out of scope for this change, per the issue.
