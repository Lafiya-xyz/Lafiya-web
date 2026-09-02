# CHW payout indexer

## Payout amount policy

There is no fixed per-registration amount and no tiering logic anywhere in
this codebase. `chw_payouts.amount_usdc` is **not computed** by
`app/api/chw/payouts/route.ts` — that route only reads and serializes the
already-stored value (`serializePayout` in
`app/api/chw/payouts/route.ts:57-77`) for display to the CHW.

The actual amount is set once, at index time, from the real on-chain
transfer:

1. `lib/stellar/payout-indexer/sources.ts` reads each Horizon payment
   operation for `CHW_INCENTIVE_POOL_ADDRESS` and takes `operation.amount`
   (the literal USDC amount that was sent on-chain) as `amountUsdc`
   (`sources.ts:166`).
2. `lib/stellar/payout-indexer/store.ts` passes that value straight through
   to the `apply_chw_payout` SQL function as `p_amount_usdc`
   (`store.ts:57-65`), which persists it into `chw_payouts.amount_usdc`.

In other words: **the payout amount is whatever the incentive-pool operator
actually paid out on-chain for that attestation's `record_hash`**, not a
platform-calculated figure. The indexer is a passive recorder/reconciler of
that external payment, not a source of payout policy. Anyone changing "how
much a CHW gets paid" needs to change the amount sent from
`CHW_INCENTIVE_POOL_ADDRESS`, not any code in this repository.

## Event-source decision

`lafiya-web` and its documented `lafiya-contracts` interface define
`attest(record_hash, attester, timestamp)` and `get_attestation(record_hash)`.
They do not define a public contract event or an event topic. The indexer
therefore does not assume that `getEvents` can see attestations.

Instead, it pages successful ledger transactions through Soroban RPC
`getTransactions`, decodes invoke-contract operations addressed to
`ATTESTATION_CONTRACT_ID`, and accepts only calls whose function is exactly
`attest`. The three invocation arguments are the authoritative record hash,
attester address, and timestamp. This is a ledger polling fallback, not
synthetic data. It also remains usable if the contract emits no public event.
A future contracts release may add a stable event ABI; switching the source
then does not require changing reconciliation or persistence.

Payouts are paged from Horizon's account payments endpoint for
`CHW_INCENTIVE_POOL_ADDRESS`. Only outgoing `USDC` payments with the configured
issuer are accepted. A qualifying payout transaction **must use MemoHash with
the attestation's 32-byte `record_hash`**. Payments without that deterministic
correlation key are ignored rather than guessed.

## Durability and reconciliation

Soroban and Horizon cursors live in `stellar_indexer_cursors`. A cursor advances
only after every event in its fetched page has been applied. A crash in the
middle leaves the old cursor in place, so the entire page is retried.
`record_hash` and `payout_tx_hash` uniqueness make this at-least-once replay
idempotent.

The streams may arrive in either order:

- Attestation first creates a pending `chw_payouts` row; a later matching
  payout makes it paid.
- Payout first creates a service-only `chw_payout_observations` row. The later
  attestation atomically creates the payout row, applies the observation, and
  removes it.
- The destination must equal the attester address. A mismatch remains an
  observation and is logged as a reconciliation decision; it never marks a
  different CHW as paid.

The SQL reconciliation functions are `security definer`, have a locked
`search_path`, and are executable only by `service_role`. No client RLS write
policy is added.

## Deployment and backfill

Invoke `POST /api/internal/payout-indexer` from the existing scheduler with:

```text
Authorization: Bearer $PAYOUT_INDEXER_CRON_SECRET
```

Configure all variables documented in `.env.example`. Schedule invocations
often enough that the RPC provider's transaction retention window is not
exceeded. Concurrent invocations are safe because writes are idempotent,
although a single scheduled invocation at a time avoids redundant network
work.

For a fresh backfill, set `PAYOUT_INDEXER_START_LEDGER` to a ledger retained by
the configured Soroban RPC and set `PAYOUT_INDEXER_START_PAYMENT_CURSOR` to the
desired Horizon paging token (`0` means the account's complete retained
history). Delete only the two rows from `stellar_indexer_cursors` using an
authorized operational migration or Supabase SQL session, then invoke the
endpoint repeatedly. It will page forward without manual row insertion.

If the requested ledger predates RPC retention, the process fails visibly and
does not advance its cursor. Use an archival RPC provider or a newer start
ledger; it will never silently skip the unavailable range.
