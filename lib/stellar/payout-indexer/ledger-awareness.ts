/**
 * Ledger-aware observation model: enables resilience to provider lag,
 * duplicate events, conflicting observations, and rollback/reorg scenarios.
 *
 * Tracks ledger checkpoints (highest confirmed ledger per stream), records
 * evidence for all decisions, and flags conflicts for operator reconciliation.
 */

/**
 * Ledger checkpoint: the confirmed boundary for a stream.
 * Used to detect provider disagreement and enforce finality.
 */
export interface LedgerCheckpoint {
  /** Highest ledger number successfully applied and confirmed */
  ledgerNumber: bigint;
  /** Cursor/paging token at this ledger (for recovery) */
  cursor: string;
  /** ISO timestamp of the last successful apply */
  confirmedAt: Date;
  /** Transaction hash of the last event applied (for dedup awareness) */
  lastTxHash: string | null;
}

/**
 * Evidence recorded for an accepted attestation or payout decision.
 * Forms an immutable audit trail and enables deterministic replay.
 */
export interface DecisionEvidence {
  id: string;
  recordHash: string;
  stellarAddress: string;
  ledgerNumber: bigint;
  transactionHash: string;
  pagingToken?: string;
  amountUsdc?: string;
  attesterOrPaidAt: string; // ISO timestamp
  decision: string; // 'pending', 'paid', 'awaiting_attestation', etc.
  evidenceRecordedAt: Date;
  evidenceChecksum: string;
}

/**
 * Detected conflict: a record observed in two inconsistent states.
 * Operators review conflicting_observations table to identify and reconcile.
 */
export interface ConflictingObservation {
  id: string;
  recordHash: string;
  conflictType:
    | "revoked_attestation"
    | "address_mismatch"
    | "reorg_detected"
    | "provider_disagreement"
    | "duplicate_payout"
    | "stale_cache"
    | "checksum_mismatch";
  previousState: Record<string, unknown> | null;
  currentState: Record<string, unknown> | null;
  detectedAt: Date;
  resolved: boolean;
  resolutionNotes: string | null;
  resolvedAt: Date | null;
}

/**
 * Result of a record-apply operation with ledger awareness.
 * Returns not just the decision, but evidence recorded and any conflicts detected.
 */
export interface LedgerAwareApplyResult {
  /** The base decision (pending, paid, awaiting_attestation, etc.) */
  decision: string;
  /** Whether evidence was successfully recorded */
  evidenceRecorded: boolean;
  /** Reason if evidence recording failed */
  evidenceFailureReason?: string;
  /** True if a reorg or provider disagreement was detected */
  reorgDetected: boolean;
  /** True if a conflict was logged for operator review */
  conflictLogged: boolean;
}

/**
 * Stream reconciliation summary: auditing state at checkpoint boundaries.
 * Used to detect silent divergence between verification and payout state.
 */
export interface StreamReconciliationSummary {
  stream: "attestations" | "payments";
  lastCheckpoint: LedgerCheckpoint | null;
  totalEventsProcessed: number;
  totalConflictsDetected: number;
  unresolvedConflictCount: number;
  lastConflictType?: string;
  lastConflictTime?: Date;
}

/**
 * Compute MD5 checksum of decision evidence for integrity checks.
 * Used to detect corruption or tampering in the evidence log.
 */
export function computeEvidenceChecksum(evidence: {
  recordHash: string;
  stellarAddress: string;
  ledgerNumber: bigint;
  transactionHash: string;
  attesterOrPaidAt: string;
  decision: string;
}): string {
  // In production, use crypto.subtle.digest('SHA-256', ...) for better security.
  // For now, this is a placeholder that assumes the database computes MD5.
  const parts = [
    evidence.recordHash,
    evidence.stellarAddress,
    evidence.ledgerNumber.toString(),
    evidence.transactionHash,
    evidence.attesterOrPaidAt,
    evidence.decision,
  ];
  return `checksum:${parts.join(":")}`;
}

/**
 * Detect if a new event's ledger indicates a reorg or provider disagreement.
 * Called before applying an event; if true, the event should trigger conflict logging.
 *
 * Returns true if:
 * - Event ledger is lower than the last confirmed checkpoint
 * - OR event cursor appears to be a backwards-jump in paging token
 */
export function isLedgerReorgLikely(
  checkpoint: LedgerCheckpoint | null,
  newLedger: bigint,
  newCursor: string,
): boolean {
  if (!checkpoint) {
    // No prior checkpoint: this is the first run, safe
    return false;
  }

  // Event ledger lower than confirmed: reorg
  if (newLedger < checkpoint.ledgerNumber) {
    return true;
  }

  // Same ledger but cursor moved backwards: provider disagreement
  if (
    newLedger === checkpoint.ledgerNumber &&
    isTokenBackwards(checkpoint.cursor, newCursor)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a paging token moved backwards (naive implementation).
 * Horizon paging tokens are opaque, but if they're string comparable,
 * a backwards move is suspicious.
 */
function isTokenBackwards(oldToken: string, newToken: string): boolean {
  // In practice, Horizon paging tokens are time-ordered.
  // A naive check: if both parse as numbers, compare them.
  const oldNum = parseInt(oldToken, 10);
  const newNum = parseInt(newToken, 10);

  if (Number.isNaN(oldNum) || Number.isNaN(newNum)) {
    // Non-numeric tokens: can't determine, assume safe
    return false;
  }

  return newNum < oldNum;
}

/**
 * Determine if a record's state should be reconciled due to conflicting observations.
 * Called post-apply to check consistency between attestation and payout state.
 */
export function shouldReconcileRecord(
  recordHash: string,
  attestationState: { exists: boolean; revoked?: boolean; expiry?: number } | null,
  payoutState: {
    status: "pending" | "paid" | "awaiting_attestation" | "address_mismatch";
  } | null,
): boolean {
  // No attestation but payout marked paid: inconsistent
  if (!attestationState && payoutState?.status === "paid") {
    return true;
  }

  // Attestation revoked but payout marked paid: inconsistent
  if (attestationState?.revoked && payoutState?.status === "paid") {
    return true;
  }

  // Attestation expired but payout marked paid: inconsistent
  const now = Math.floor(Date.now() / 1000);
  if (attestationState?.expiry && attestationState.expiry < now && payoutState?.status === "paid") {
    return true;
  }

  return false;
}

/**
 * Build a conflict observation payload for logging to the database.
 * Used when inconsistency is detected.
 */
export function buildConflictObservation(
  recordHash: string,
  conflictType: ConflictingObservation["conflictType"],
  previousState: Record<string, unknown>,
  currentState: Record<string, unknown>,
): Omit<ConflictingObservation, "id" | "detectedAt" | "resolved" | "resolutionNotes" | "resolvedAt"> {
  return {
    recordHash,
    conflictType,
    previousState,
    currentState,
  };
}
