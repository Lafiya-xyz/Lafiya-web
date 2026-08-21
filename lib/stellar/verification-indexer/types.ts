/** Protocol event fixture emitted by the v1 contracts/verifier integration. */
export type FinalizedAttestationEvent = {
  eventId: string;
  intentId: string;
  recordCommitment: string;
  attesterAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  ledgerHash: string;
  eventIndex: number;
  observedAt: string;
  finalizedAt: string;
  networkPassphraseHash: string;
  contractId: string;
  contractVersion: string;
  schemaVersion: number;
  idempotencyKey: string;
};

export type VerificationEventPage = {
  events: FinalizedAttestationEvent[];
  cursor: string;
};

export type VerificationEventSource = {
  read(cursor: string | null): Promise<VerificationEventPage>;
};

export type VerificationEvidenceStore = {
  getCursor(): Promise<string | null>;
  applyFinalized(event: FinalizedAttestationEvent): Promise<void>;
  quarantine(eventId: string, reasonCode: string): Promise<void>;
  saveCursor(cursor: string): Promise<void>;
};
