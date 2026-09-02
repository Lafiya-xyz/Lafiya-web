# Implement the end-to-end CHW verification and attestation workflow across repositories

## Category

Advanced

## Summary

Deliver the production workflow that lets an authorized CHW retrieve a patient re-attestation request, verify the current record, submit the Soroban attestation, and reconcile completion in `lafiya-web`.

## Current Behavior

The patient app computes HMAC-backed hashes and inserts `reattestation_requests`. `lib/stellar/attestation.ts` reads the contract, and the payout indexer reads on-chain payment state. The README identifies `lafiya-verifier` as planned, and no end-to-end CHW write workflow exists in these repositories.

## Problem

The core trust loop stops at a patient request: there is no authorized actor, transaction lifecycle, completion proof, or user-visible confirmation that the current card was re-attested.

## Why This Matters

This is the product’s central growth workflow and a prerequisite for trustworthy CHW incentives and pilot deployment.

## Proposed Scope

Implement the coordinated verifier/web protocol: request claiming, CHW identity and allowlist checks, record-hash confirmation, Soroban transaction submission/status handling, idempotent completion, and patient-side status refresh. Include explicit pending, failed, expired, and confirmed states.

## Acceptance Criteria

- [ ] Only an authorized CHW can claim and complete a request.
- [ ] Completion is accepted only for the current record hash, expected contract, and network.
- [ ] Retries do not create duplicate attestations or duplicate payout eligibility.
- [ ] Transaction submission, confirmation, timeout, and rejection states are recoverable.
- [ ] Patient UI distinguishes requested, processing, verified, and failed states.
- [ ] End-to-end test fixtures cover both repositories’ shared interface.

## Technical Considerations

Coordinate `reattestation_requests`, `recordHash`, `get_attestation`, contract allowlisting, event/payout correlation, and environment keys. Treat transaction hashes and ledger evidence as idempotency material; never send emergency data to the chain.

## Testing Requirements

Test authorization, stale-hash rejection, duplicate delivery, RPC interruption, transaction replacement/retry, and eventual completion.

## Cross-Repository Impact

`lafiya-web`, `lafiya-verifier`, and `lafiya-contracts`; shared attestation schema, request-completion interface, and deployment configuration.

## Out of Scope

Changing the medical data model or designing a new blockchain protocol unrelated to attestation.

## Complexity

Advanced — security-sensitive distributed workflow spanning identity, web state, wallet/transaction lifecycle, and Soroban.

## Impact

Critical — unblocks the primary verification and incentive product loop.

## Suggested Labels

`advanced`, `stellar`, `soroban`, `security`, `cross-repository`
