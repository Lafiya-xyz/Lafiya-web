# Add ledger-aware attestation consistency and reorganization handling

## Category

Advanced

## Summary

Make attestation reads and downstream state resilient to ledger progression, duplicate events, provider disagreement, and rollback/reorg-like availability conditions.

## Current Behavior

`lib/stellar/attestation.ts` reads a current contract result through Soroban simulation and caches it. The payout indexer persists cursors and reconciles attestation/payout arrival order, but there is no shared ledger checkpoint or consistency policy between public verification, reattestation completion, and payout eligibility.

## Problem

Different components can make decisions from different ledger views or stale cache entries, producing inconsistent verified and paid states during provider lag or replay.

## Why This Matters

Verification and financial eligibility must not diverge silently, especially around newly submitted or revoked attestations.

## Proposed Scope

Define a ledger-aware observation model, persist the evidence needed for decisions, enforce confirmation/finality policy, and update the read/indexer interfaces so replay and provider lag resolve deterministically. Add reconciliation for records observed in conflicting states.

## Acceptance Criteria

- [ ] Every accepted attestation/payout decision records sufficient ledger/transaction evidence.
- [ ] Duplicate and out-of-order observations are idempotent.
- [ ] Provider lag or conflicting responses cannot silently turn an unconfirmed state into verified/paid.
- [ ] Recovery replays from a known checkpoint without skipping events.
- [ ] Operators can identify and reconcile inconsistent records.

## Technical Considerations

Coordinate Soroban RPC, Horizon paging tokens, `stellar_indexer_cursors`, `chw_payout_observations`, attestation cache tags, and contract event semantics. Preserve privacy boundaries and existing public-card fallback behavior.

## Testing Requirements

Test duplicate batches, provider lag, checkpoint restart, conflicting observations, revocation, and eventual convergence of card and payout state.

## Cross-Repository Impact

`lafiya-web` indexer/read path; `lafiya-contracts` event and state semantics; any shared verifier gateway.

## Out of Scope

Replacing Stellar consensus or building a general-purpose blockchain indexer.

## Complexity

Advanced — distributed consistency and financial/trust decisions span multiple state sources.

## Impact

Critical — protects correctness of the verified indicator and CHW payout ledger.

## Suggested Labels

`advanced`, `stellar`, `indexer`, `reliability`, `data-integrity`
