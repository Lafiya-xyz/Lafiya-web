# CHW verification, trust, and incentive protocol

Issue: #172

This document defines the application-side protocol for the immutable
`record_revisions` model. It is deliberately hash-only: no patient record
content, disclosure payload, or medical outcome is placed in a ledger event,
intent, payout memo, log, trace, dead-letter queue, or durable worker job.

## Authority boundaries

| Boundary                   | Authority                                                   | What it does not authorize                             |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Application identity       | Supabase `auth.users`                                       | Attesting or receiving payment by itself               |
| Professional authorization | `chw_identities`, credential expiry, audited approval       | Changing a Stellar recipient alone                     |
| Stellar authorization      | Contract allowlist at the registered contract epoch         | Viewing patient data or bypassing an application lease |
| Patient authorization      | Latest `clinical_verification` consent and current revision | Reusing authorization for a successor revision         |

An active CHW has a unique bound Stellar address and a SEP-53 proof of
ownership. Enrollment, suspension, recovery, rotation, offboarding, and
break-glass access append an authorization audit event. Production operations
require a requester and a distinct approver for activation, suspension,
rotation, recovery, contract-epoch changes, and payout adjustments. A
break-glass event is time-limited, read-only by default, requires a reason
code, and is reviewed the next business day.

## Claim and submission flow

```text
CHW                 verifier/API             database                 Soroban
 | claim             |                         |                         |
 |------------------>| active identity         |                         |
 |                   |------------------------>| lock oldest request     |
 |                   |<------------------------| revision + lease token  |
 | review exact disclosed revision             |                         |
 | signed intent     |                         |                         |
 |------------------>| verify signature        |                         |
 |                   |------------------------>| bind lease, revision,   |
 |                   |                         | CHW/address, epoch      |
 |                   | submit only hash ------------------------------->|
 |                   |                         |                          |
 |                   |<------------------------ ledger worker evidence --|
```

`claim_verification_request` locks one eligible row using `SKIP LOCKED`; a
lease is 60–1,800 seconds. Renewal and release require the CHW, opaque lease
token, and an unexpired lease. A newer patient revision supersedes pending or
in-review requests, so neither the old lease nor a shared card ID can verify
the new revision.

A submitted intent is canonical JSON and binds request ID, revision ID,
record hash, schema version, network-passphrase SHA-256, contract ID, CHW ID,
Stellar address, and expiry. The application records an idempotency key per
CHW, and one submission per request. A verifier must validate the wallet
signature before it calls the database function; the database repeats every
authorization and binding check transactionally.

Stable rejection codes include `CHW_NOT_AUTHORIZED`, `LEASE_NOT_ACTIVE`,
`INVALID_OR_EXPIRED_INTENT`, `UNSUPPORTED_CONTRACT_EPOCH`,
`INTENT_BINDING_MISMATCH`, `REQUEST_ALREADY_SUBMITTED`, and
`INSUFFICIENT_FINALITY_EVIDENCE`.

## Trust decisions

| State                 | Safe responder copy            | Evidence rule                                                                                            |
| --------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `unverified`          | Not verified                   | No final evidence                                                                                        |
| `submitted`           | Verification submitted         | Intent accepted, no ledger observation                                                                   |
| `confirming`          | Verification confirming        | Observation exists but finality depth not met                                                            |
| `verified`            | Verified                       | Exact current revision, matching epoch, transaction/ledger/event evidence, and configured finality depth |
| `expired` / `revoked` | Verification expired / revoked | Contract evidence says so                                                                                |
| `superseded`          | Verification superseded        | Revision is no longer the current record                                                                 |
| `conflicted`          | Verification unavailable       | Providers or replay evidence disagree                                                                    |
| `unavailable`         | Verification unavailable       | A bounded provider call could not establish evidence                                                     |

`verified` is never inferred from RPC success. Each accepted contract epoch
specifies a minimum finality depth. The reconciliation worker records the
transaction hash, ledger sequence/hash, event position, observed/finalized
timestamps, and non-PHI evidence. A fork or provider disagreement appends a
new `conflicted` event; it never leaves an earlier green status silently in
place.

## Incentives and operations

Final verification creates one `payout_obligations` row, uniquely keyed by the
verification submission. Its recipient is copied from the address bound at
submission time, not read from a mutable identity row later. The obligation
contains the amount/version, asset issuer, sponsor pool, and settlement state.
It is independent of payment observation: only a ledger-confirmed settlement
may mark it settled.

The event indexer remains at-least-once. It applies an event before advancing
its cursor, retries bounded transient failures, and retains malformed or
unsupported events in a non-PHI quarantine record for operator review. On a
reorg it replays from a checkpoint and appends replacement trust evidence.
The reporting invariant is:

```text
obligations = settled + pending + quarantined + explicitly adjusted
```

## Incident runbook summary

- **Compromised CHW/device:** suspend the identity, remove its on-chain
  allowlist authorization, expire open leases, and reconcile affected
  submissions. Do not redirect historical obligations.
- **Compromised admin:** pause new activation, rotation, and payouts; rotate
  multisig/admin keys; add a successor contract epoch; reconcile every
  affected address and decision.
- **Contract upgrade:** register the new epoch before writes, dual-read during
  the migration window, and preserve old epoch evidence. Historical
  attestations remain valid only under their recorded epoch policy.
- **Provider outage/disagreement:** fail closed to `unavailable` or
  `conflicted`, alert without PHI, retry with bounded backoff, then replay from
  the last applied checkpoint.
