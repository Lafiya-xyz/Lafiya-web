# Ledger-Aware Attestation Consistency and Reorganization Handling

## Overview

This document describes the implementation of ledger-aware observation model for the Lafiya payout indexer, protecting attestation reads and downstream state from ledger progression, duplicate events, provider disagreement, and rollback/reorg scenarios.

## Problem Statement

Previously, the indexer read attestation and payout state independently without shared ledger checkpoints or consistency policies. This caused:

- **Silent divergence**: Verification and payout eligibility could diverge during provider lag
- **Duplicate events**: Out-of-order reprocessing could create inconsistent records
- **Reorg blindness**: Ledger reorganizations weren't detected or tracked
- **No audit trail**: Decisions weren't persisted with transaction evidence for reconciliation

## Solution Architecture

### 1. Ledger Checkpoint Model

Each stream (`attestations` and `payments`) maintains a checkpoint in the `ledger_checkpoints` table:

```sql
CREATE TABLE ledger_checkpoints (
  stream TEXT PRIMARY KEY,
  ledger_number BIGINT,
  cursor TEXT,
  confirmed_at TIMESTAMPTZ,
  last_tx_hash TEXT,
  updated_at TIMESTAMPTZ
);
```

**Key Properties:**
- Per-stream isolation: attestation and payment progress are independent
- Finality enforcement: checkpoint only updates after all events in a page are applied
- Recovery support: cursor enables restart from known boundary without skipping events
- Reorg detection: comparing new event ledgers against checkpoint ledger detects backwards movement

### 2. Decision Evidence Tables

#### attestation_evidence

Records every accepted attestation with full ledger proof:

```sql
CREATE TABLE attestation_evidence (
  id UUID PRIMARY KEY,
  record_hash TEXT NOT NULL,
  stellar_address TEXT NOT NULL,
  ledger_number BIGINT NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE,
  attested_at TIMESTAMPTZ NOT NULL,
  decision TEXT NOT NULL,
  evidence_checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
```

#### payout_evidence

Records every accepted payout with Horizon proof:

```sql
CREATE TABLE payout_evidence (
  id UUID PRIMARY KEY,
  record_hash TEXT NOT NULL,
  stellar_address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL UNIQUE,
  paging_token TEXT NOT NULL UNIQUE,
  amount_usdc NUMERIC(20, 7) NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL,
  decision TEXT NOT NULL,
  evidence_checksum TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
```

**Evidence Recording:**
- Checksum on all fields detects corruption or tampering
- Unique constraints on transaction_hash prevent duplicates
- Decision field tracks the apply result (pending, paid, awaiting_attestation, etc.)

### 3. Conflict Detection

The `conflicting_observations` table flags records observed in inconsistent states:

```sql
CREATE TABLE conflicting_observations (
  id UUID PRIMARY KEY,
  record_hash TEXT NOT NULL,
  conflict_type TEXT CHECK (conflict_type IN (
    'revoked_attestation',
    'address_mismatch',
    'reorg_detected',
    'provider_disagreement',
    'duplicate_payout',
    'stale_cache',
    'checksum_mismatch'
  )),
  previous_state JSONB,
  current_state JSONB,
  detected_at TIMESTAMPTZ,
  resolved BOOLEAN,
  resolution_notes TEXT,
  resolved_at TIMESTAMPTZ
);
```

**Conflict Types:**
- `revoked_attestation`: Attestation revoked but payout marked paid
- `address_mismatch`: Payout destination doesn't match attester
- `reorg_detected`: Event ledger lower than confirmed checkpoint
- `provider_disagreement`: Provider cursors diverged
- `duplicate_payout`: Multiple payouts for same record
- `stale_cache`: Cache stale during provider lag
- `checksum_mismatch`: Evidence data integrity failure

## Implementation Details

### Reorg Detection

The `isLedgerReorgLikely(checkpoint, newLedger, newCursor)` function detects backwards movement:

```typescript
if (!checkpoint) return false; // First run, no reorg
if (newLedger < checkpoint.ledgerNumber) return true; // Ledger moved backwards
if (newLedger === checkpoint.ledgerNumber && isTokenBackwards(...)) return true; // Token gap
```

Called before applying each event; if true, the event triggers conflict logging.

### Idempotent Apply

Both `applyAttestation` and `applyPayout` record evidence and detect duplicates:

1. **Duplicate detection via checksum**: If evidence exists with identical checksum, return `'idempotent_duplicate'`
2. **Conflict detection on mismatch**: If transaction_hash exists but checksum differs, log conflict
3. **Safe upsert**: Database constraints ensure at most one record per (record_hash, transaction_hash)

### Checkpoint Update Policy

Checkpoint updates only occur after entire page is applied:

```typescript
for (const event of attestationPage.events) {
  const result = await store.applyAttestation(event);
  // ... handle result
}

// Only after all events succeed
if (attestationPage.events.length > 0) {
  await store.updateLedgerCheckpoint(
    "attestations",
    maxLedger,
    cursor,
    lastTxHash
  );
}
```

This ensures:
- **Crash safety**: Mid-page crash leaves old checkpoint, entire page retries
- **At-least-once semantics**: No event is skipped, duplicates are idempotent
- **Finality**: Only confirmed events update the checkpoint

### Out-of-Order Handling

Attestations and payouts can arrive in either order via `chw_payout_observations`:

**Scenario A: Payout First**
1. Payout arrives, no matching attestation → insert into `chw_payout_observations`
2. Attestation arrives later → apply attestation, fetch observation, atomically move to `chw_payouts`, delete observation

**Scenario B: Attestation First**
1. Attestation arrives, create pending row in `chw_payouts`
2. Payout arrives later → atomic upsert matches and moves to `status='paid'`

## Reconciliation Engine

The `ReconciliationEngine` runs independently to detect silently diverged records:

### reconcileAll()

Compares attestation and payout state across all records:

```typescript
const batch = await engine.reconcileAll();

batch.paidButNotVerified    // Paid but no attestation
batch.verifiedButNotPaid    // Verified but not paid
batch.revokedButPaid        // Revoked but payout persists
batch.expiredButPaid        // Expired but payout persists
batch.addressMismatchRecords // CHW address mismatch
```

### reconcileRecord(recordHash)

Deep audit of a single record with evidence chain timeline:

```typescript
const { record, evidenceChain, recommendedActions } = 
  await engine.reconcileRecord("hash");

// evidenceChain: [{type, timestamp, ledger, txHash, decision}, ...]
// recommendedActions: ["ACTION: ...", "INFO: ...", ...]
```

### logReconciliationConflicts(batch)

Formally logs detected inconsistencies to `conflicting_observations` for operator review.

## Cache Invalidation Strategy

The attestation cache is invalidated based on detected conflicts:

### Invalidation Policies

```typescript
invalidateByConflictType(conflictType, recordHash?, recordHashes?) {
  case "revoked_attestation":
    invalidateAttestationCache(recordHash, "revoked");
  case "reorg_detected":
    invalidateAttestationCacheBatch(recordHashes, "bulk_reorg");
  case "provider_disagreement":
    invalidateAllAttestationCaches(); // Wide scope, play it safe
  case "checksum_mismatch":
    invalidateAllAttestationCaches(); // Data integrity: don't trust any cache
}
```

**Per-Hash Invalidation**: Single record revoked or recovered
**Batch Invalidation**: Multiple records affected by reorg
**Global Invalidation**: Provider disagreement or data corruption

## Integration Points

### Indexer Loop Enhancement

```typescript
// 1. Read checkpoints before processing
const [attestationCheckpoint, paymentCheckpoint] = await Promise.all([
  store.getLedgerCheckpoint("attestations"),
  store.getLedgerCheckpoint("payments"),
]);

// 2. Apply events with ledger awareness
for (const event of attestationPage.events) {
  const result = await store.applyAttestation(event);
  if (result.reorgDetected) logWarn("Reorg detected", {...});
  if (result.conflictLogged) conflictCount++;
}

// 3. Update checkpoint after all events succeed
await store.updateLedgerCheckpoint("attestations", maxLedger, cursor, lastTx);

// 4. Report conflicts in summary
return {
  attestationCheckpoint,
  paymentCheckpoint,
  conflictCount,
  ...
};
```

### Periodic Reconciliation (Recommended)

Run reconciliation independently on a cron schedule (e.g., hourly):

```typescript
const engine = new ReconciliationEngine();
const batch = await engine.reconcileAll();
if (batch.inconsistentRecords.length > 0) {
  await engine.logReconciliationConflicts(batch);
  // Alert operator
}
```

### Public Card Verification (Unchanged)

Existing public card flow is resilient:

1. Fetch emergency card data
2. Compute record hash deterministically
3. Call `validateAttestation(recordHash)` → queries Soroban RPC (cached, with circuit breaker)
4. If cache stale during provider lag, TTL ensures fresh read within 120s
5. Cache invalidation ensures new attestations are visible immediately

## Acceptance Criteria Met

✅ **Every accepted attestation/payout decision records sufficient ledger/transaction evidence**
- `attestation_evidence` and `payout_evidence` tables persist all proof

✅ **Duplicate and out-of-order observations are idempotent**
- Checksum-based duplicate detection
- Observation table decouples streams
- Unique constraints on transaction_hash

✅ **Provider lag or conflicting responses cannot silently turn an unconfirmed state into verified/paid**
- Ledger checkpoint tracks confirmed boundary
- Reorg detection flags backwards movement
- Evidence checksum detects corruption

✅ **Recovery replays from a known checkpoint without skipping events**
- Cursor persisted in `ledger_checkpoints`
- Crash mid-page → restart from old cursor
- At-least-once semantics ensure no gap

✅ **Operators can identify and reconcile inconsistent records**
- `conflicting_observations` table
- `ReconciliationEngine.reconcileAll()` for detection
- Dashboard shows unresolved conflicts
- `reconcileConflictingRecord()` for manual resolution

## Testing Coverage

### Ledger Awareness Tests
- Reorg detection (shallow/deep)
- Finality policy enforcement
- Checkpoint recovery
- Provider lag scenarios

### Reconciliation Tests
- Inconsistency detection (5 types)
- Evidence chain reconstruction
- Recommendation generation
- Operator workflow simulation
- Bulk reconciliation (1000+ records)

### Idempotency Tests
- Duplicate attestation events
- Duplicate payout events
- Out-of-order attestation then payout
- Out-of-order payout then attestation (observation path)
- Concurrent applies

## Operational Guidance

### Monitoring

Check `conflicting_observations` regularly:

```sql
SELECT conflict_type, COUNT(*) 
FROM conflicting_observations 
WHERE resolved = FALSE 
GROUP BY conflict_type;
```

### Manual Reconciliation

For a suspicious record:

```typescript
const { record, evidenceChain, recommendedActions } = 
  await engine.reconcileRecord("record-hash");

// Review evidenceChain timeline
// Follow recommendedActions
// Either mark resolved or escalate
```

### Emergency Recovery

If widespread divergence is detected:

```typescript
// 1. Log the batch of conflicts
await engine.logReconciliationConflicts(batch);

// 2. Invalidate attestation caches for affected records
await invalidateAttestationCacheBatch(
  batch.inconsistentRecords.map(r => r.recordHash),
  "bulk_reorg"
);

// 3. Restart indexer from a known good checkpoint
// (manual database edit or operator tool)
```

## Future Improvements

1. **Per-Hash Cache Tags**: Switch from generic `"attestation"` tag to per-hash `"attestation:${recordHash}"` for surgical invalidation
2. **Distributed Checkpoint**: Add optional Redis-backed checkpoint for multi-instance coordination
3. **Event-Based Invalidation**: Implement contract event subscriptions to invalidate cache immediately on new attestations (rather than waiting for TTL)
4. **Automated Reconciliation**: Built-in scheduler for periodic reconciliation with alerting
5. **Audit API**: Public endpoint for operators to query evidence and conflict timeline per record

## Security & Privacy

- Evidence tables are service-role only (RLS enforced)
- No PII exposed in evidence; only record_hash and stellar address (public)
- Conflict observations are internal diagnostic data
- No changes to existing public-card privacy boundaries
