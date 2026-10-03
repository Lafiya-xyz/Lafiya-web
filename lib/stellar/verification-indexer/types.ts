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

/**
 * Administrative events emitted by the attestation contract (issue #629).
 * `wasmHash` is set for upgrades; `subject` is the admin or attester address
 * an admin transfer or allowlist change refers to.
 */
export type ContractAdminEventKind =
  "wasm_upgrade" | "admin_transfer" | "allowlist_change" | "pause" | "unpause";

export type ContractAdminEvent = {
  eventId: string;
  kind: ContractAdminEventKind;
  contractId: string;
  ledgerSequence: number;
  transactionHash: string;
  observedAt: string;
  wasmHash?: string;
  subject?: string;
  action?: "added" | "removed";
};

export type ContractAdminEventPage = {
  events: ContractAdminEvent[];
  cursor: string;
};

export type ContractAdminEventSource = {
  read(cursor: string | null): Promise<ContractAdminEventPage>;
};

/**
 * "trusted": the contract runs approved code and is not paused.
 * "needs_review": an unapproved WASM hash was observed; attestations are
 * shown as "verification temporarily unavailable" until an operator approves
 * the hash (adds it to ATTESTATION_APPROVED_WASM_HASHES).
 * "paused": the contract admin paused the contract.
 */
export type ContractTrustState = "trusted" | "needs_review" | "paused";

export type ContractTrustStatus = {
  state: ContractTrustState;
  wasmHash: string | null;
  reasonCode: string | null;
};

export type ContractGovernanceStore = {
  getCursor(): Promise<string | null>;
  getTrustStatus(): Promise<ContractTrustStatus | null>;
  recordAdminEvent(event: ContractAdminEvent): Promise<void>;
  setTrustStatus(status: ContractTrustStatus): Promise<void>;
  saveCursor(cursor: string): Promise<void>;
};

export type OperatorAlert = {
  code:
    | "UNAPPROVED_WASM_HASH"
    | "ADMIN_TRANSFERRED"
    | "CONTRACT_PAUSED"
    | "ALLOWLIST_CHANGED";
  contractId: string;
  eventId: string;
  wasmHash?: string;
};

export type OperatorAlerter = {
  alert(alert: OperatorAlert): Promise<void>;
};
