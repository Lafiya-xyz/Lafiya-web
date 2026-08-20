# Add an authenticated CHW payout history API with cursor pagination

## Category

Intermediate

## Summary

Expose a least-privilege, paginated payout-history API for an authenticated CHW using the durable `chw_payouts` mirror.

## Current Behavior

The indexer writes `public.chw_payouts`, but this web repository has no route or component that reads a CHW’s earnings. The table has an RLS select policy keyed by `chw_id`, while the indexer correlates Stellar addresses and record hashes.

## Problem

The payout pipeline creates durable data but provides no product surface for a CHW to confirm pending or paid earnings.

## Why This Matters

Visible, reliable payout status is required for adoption of the incentive program and reduces dependence on manual explorers or support staff.

## Proposed Scope

Define the authenticated CHW identity-to-`chw_id` mapping, add a paginated route or server action returning status, amount, timestamps, and transaction links, and enforce that record hashes and other patient identifiers are not returned.

## Acceptance Criteria

- [ ] Authenticated CHWs can retrieve only their own payout rows.
- [ ] Results support stable cursor pagination and deterministic ordering.
- [ ] Pending, paid, and reconciliation states are represented accurately.
- [ ] Amounts and transaction hashes are validated before response serialization.
- [ ] RLS/integration tests prove cross-CHW isolation and pagination correctness.

## Technical Considerations

Coordinate the meaning of `chw_id`, `stellar_address`, `status`, and `payout_tx_hash` with the indexer and future `lafiya-verifier`. Do not expose `record_hash` unless the privacy review explicitly approves it.

## Testing Requirements

Test isolation, empty and multi-page results, cursor tampering, and rows transitioning from pending to paid.

## Cross-Repository Impact

`lafiya-web` API; `lafiya-verifier` identity contract; `chw_payouts` schema and indexer semantics.

## Out of Scope

Changing payout settlement, contract logic, or building a complete CHW dashboard.

## Complexity

Intermediate — requires auth mapping, API design, RLS, pagination, and indexer compatibility.

## Impact

High — turns the existing payout ledger into a usable incentive product.

## Suggested Labels

`intermediate`, `api`, `stellar`, `payouts`, `authorization`
