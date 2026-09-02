import type {
  LedgerCheckpoint,
  LedgerAwareApplyResult,
  ConflictingObservation,
} from "./ledger-awareness";

export type StreamName = "attestations" | "payments";

export type AttestationEvent = {
  recordHash: string;
  stellarAddress: string;
  attestedAt: string;
  transactionHash: string;
  ledger: number;
};

export type PayoutEvent = {
  recordHash: string;
  stellarAddress: string;
  amountUsdc: string;
  transactionHash: string;
  paidAt: string;
  pagingToken: string;
  ledger?: number;
};

export type EventPage<T> = {
  events: T[];
  cursor: string;
};

export type AttestationSource = {
  read(
    cursor: string | null,
    startLedger: number,
  ): Promise<EventPage<AttestationEvent>>;
};

export type PayoutSource = {
  read(
    cursor: string | null,
    startCursor?: string,
  ): Promise<EventPage<PayoutEvent>>;
};

export type PayoutIndexerStore = {
  getCursor(stream: StreamName): Promise<string | null>;
  saveCursor(stream: StreamName, cursor: string): Promise<void>;
  
  // Ledger-aware checkpoint management
  getLedgerCheckpoint(stream: StreamName): Promise<LedgerCheckpoint | null>;
  updateLedgerCheckpoint(
    stream: StreamName,
    ledgerNumber: bigint,
    cursor: string,
    lastTxHash: string | null,
  ): Promise<void>;
  
  // Ledger reorg detection
  detectLedgerReorg(stream: StreamName, newLedger: bigint): Promise<boolean>;
  
  // Ledger-aware apply with evidence recording
  applyAttestation(event: AttestationEvent): Promise<LedgerAwareApplyResult>;
  applyPayout(event: PayoutEvent): Promise<LedgerAwareApplyResult>;
  
  // Evidence recording (called by apply functions internally)
  recordAttestationEvidence(
    recordHash: string,
    stellarAddress: string,
    ledgerNumber: bigint,
    transactionHash: string,
    attestedAt: string,
    decision: string,
  ): Promise<{ success: boolean; reason: string }>;

  recordPayoutEvidence(
    recordHash: string,
    stellarAddress: string,
    ledgerNumber: bigint | undefined,
    transactionHash: string,
    pagingToken: string,
    amountUsdc: string,
    paidAt: string,
    decision: string,
  ): Promise<{ success: boolean; reason: string }>;

  // Conflict detection and reconciliation
  getConflictingRecords(): Promise<ConflictingObservation[]>;
  reconcileConflictingRecord(
    conflictId: string,
    resolutionNotes: string,
  ): Promise<void>;
};

export type PayoutIndexerSummary = {
  attestations: number;
  payments: number;
  attestationCursor: string;
  paymentCursor: string;
  attestationCheckpoint: LedgerCheckpoint | null;
  paymentCheckpoint: LedgerCheckpoint | null;
  conflictCount: number;
};
