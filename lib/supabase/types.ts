/**
 * Hand-authored types mirroring supabase/migrations/*.sql. There is no
 * `supabase gen types` step in this project (no network dependency on a
 * hosted project); keep this file in sync with the migrations by hand.
 *
 * Every type in this file must be a `type` alias, never an `interface` —
 * including ones only referenced from inside `Database`, like `ProfileRow`.
 * supabase-js's SupabaseClient generic checks `Schema extends
 * Record<string, GenericTable>`-shaped constraints internally, and
 * TypeScript's structural `extends` only recognizes plain object type
 * aliases as satisfying an index-signature type like `Record<string, X>`.
 * An `interface` with identical members does not, anywhere in the tree,
 * and silently collapses every query's result type to `never` with no
 * error at the `Database` definition site itself — the error only
 * surfaces later, at each `.from(...).select(...)` call.
 */

export type BloodGroup =
  "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | "unknown";

export type Genotype = "AA" | "AS" | "SS" | "SC" | "AC" | "unknown";

export type EmergencyContact = {
  name: string;
  phone: string;
  relationship: string;
};

/** Row shape of public.profiles. */
export type ProfileRow = {
  user_id: string;
  card_public_id: string;
  name: string;
  date_of_birth: string | null;
  photo_url: string | null;
  language: string | null;
  blood_group: BloodGroup;
  genotype: Genotype;
  allergies: string[];
  medications: string[];
  chronic_conditions: string[];
  emergency_contacts: EmergencyContact[];
  /**
   * record_hash (hex) as of the last time this profile was observed to
   * have a valid on-chain attestation. Never exposed via
   * get_emergency_card() — see profiles-column-contract.test.ts.
   */
  last_attested_hash: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
  current_revision_id: string | null;
  disclosure_policy: DisclosurePolicy;
  legacy_card_sunset_at: string;
  /**
   * Fields the patient marked clinician-only (issue #543 break-glass).
   * Never exposed via get_emergency_card() or consume_emergency_capability()
   * — only through open_break_glass_access() to a verified clinician.
   */
  clinician_disclosure_policy: DisclosurePolicy;
};

export type EmergencyCapabilityPurpose = "emergency" | "temporary";

export type EmergencyCapabilityRow = {
  id: string;
  user_id: string;
  token_digest: string;
  purpose: EmergencyCapabilityPurpose;
  field_allowlist: Record<string, boolean>;
  issued_at: string;
  expires_at: string;
  max_views: number | null;
  used_views: number;
  revoked_at: string | null;
  rotated_from_id: string | null;
  replaced_by_id: string | null;
  last_resolved_at: string | null;
  created_at: string;
};

/** Issue #628: HMAC-keyed duplicate-detection blocking key. */
export type PatientBlockingKeyRow = {
  user_id: string;
  key_type: "phone" | "name_dob";
  key_hash: string;
  updated_at: string;
};

export type AccountMergeRequestRow = {
  id: string;
  requester_user_id: string;
  other_user_id: string | null;
  status: "pending" | "verified" | "merged" | "cancelled";
  requester_verified_at: string | null;
  other_verified_at: string | null;
  expires_at: string;
  created_at: string;
};

export type AccountMergeAuditRow = {
  id: string;
  merge_request_id: string;
  survivor_user_id: string;
  loser_user_id: string;
  moved: Record<string, number>;
  adjusted_obligations: number;
  merged_at: string;
};

export type AccountNotificationOutboxRow = {
  id: string;
  user_id: string;
  template: "account_merged_survivor" | "account_merged_loser";
  reference_id: string;
  created_at: string;
  sent_at: string | null;
};

/** Issue #631: Argon2id hash of a capability's printed card PIN. */
export type EmergencyCapabilityPinRow = {
  capability_id: string;
  pin_hash: string;
  failed_attempts: number;
  locked_at: string | null;
  unlock_digest: string | null;
  unlock_expires_at: string | null;
  created_at: string;
};

export type CardAccessEventRow = {
  id: string;
  user_id: string;
  capability_id: string | null;
  access_kind: "legacy" | "capability";
  outcome: "served" | "inactive" | "pin_success" | "pin_failure" | "pin_locked";
  observed_at: string;
};

/** Row shape of public.emergency_contact_notification_events. See Issue #542. */
export type EmergencyContactNotificationEventRow = {
  id: string;
  user_id: string;
  capability_id: string | null;
  facility_name: string | null;
  sent_at: string;
};

export type DisclosurePolicy = {
  version: 1;
  fields: Record<string, boolean>;
  /** Issue #631: fields that require the printed card PIN. */
  requires_card_pin?: string[];
};

/** Row shape of public.break_glass_accesses (issue #543). Immutable audit trail. */
export type BreakGlassAccessRow = {
  id: string;
  patient_user_id: string;
  clinician_id: string;
  revision_id: string;
  reason: string;
  fields_disclosed: Record<string, boolean>;
  opened_at: string;
  expires_at: string;
  patient_notified_at: string | null;
};

export type RecordLifecycleState =
  | "draft"
  | "shareable"
  | "verification_requested"
  | "under_review"
  | "verified"
  | "stale_after_edit"
  | "suspended"
  | "revoked"
  | "deleted";

export type RecordRevisionRow = {
  id: string;
  user_id: string;
  predecessor_id: string | null;
  schema_version: 1;
  revision_number: number;
  lifecycle_state: RecordLifecycleState;
  emergency_data: Record<string, unknown>;
  provenance: Record<string, unknown>;
  disclosure_policy: DisclosurePolicy;
  commitment: string;
  created_by: string;
  created_at: string;
};

export type ConsentPurpose =
  | "account_processing"
  | "emergency_public_disclosure"
  | "offline_caching"
  | "clinical_verification"
  | "optional_analytics"
  | "emergency_contact_notification";

/** Row shape of public.consent_purposes. */
export type ConsentPurposeRow = {
  purpose: ConsentPurpose;
  version: number;
  required: boolean;
  description: string;
  active: boolean;
};

export type ConsentEventRow = {
  id: string;
  user_id: string;
  purpose: ConsentPurpose;
  purpose_version: number;
  action: "acknowledged" | "withdrawn";
  occurred_at: string;
  idempotency_key: string;
};

/** Row shape of public.profile_secrets. Never read/written outside lib/attestation/recordSecret.ts. */
export type ProfileSecretRow = {
  user_id: string;
  secret: string;
  created_at: string;
};

export type ReattestationRequestStatus =
  | "pending"
  | "leased"
  | "submitted"
  | "confirming"
  | "completed"
  | "dismissed"
  | "superseded"
  | "failed";

/** Row shape of public.reattestation_requests. */
export type ReattestationRequestRow = {
  id: string;
  user_id: string;
  record_hash: string;
  requested_at: string;
  status: ReattestationRequestStatus;
  revision_id: string | null;
  claimed_chw_id: string | null;
  claimed_address_binding_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  reviewed_at: string | null;
  review_outcome: "approved" | "rejected" | null;
};

export type ChwIdentityStatus =
  "pending" | "active" | "suspended" | "rotating" | "recovering" | "offboarded";

export type ChwIdentityRow = {
  chw_id: string;
  status: ChwIdentityStatus;
  credential_expires_at: string | null;
  approved_at: string | null;
  suspended_at: string | null;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type ChwAddressBindingRow = {
  id: string;
  chw_id: string;
  stellar_address: string;
  ownership_proof_digest: string;
  allowlist_synced_at: string | null;
  bound_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  approved_by: string | null;
};

export type ProtocolEpochRow = {
  id: string;
  schema_version: number;
  network_passphrase_hash: string;
  contract_id: string;
  contract_version: string;
  event_version: number;
  finality_depth: number;
  payout_amount_usdc: number;
  asset_identifier: string;
  sponsor_pool: string;
  status: "active" | "deprecated" | "retired";
  activated_at: string;
  deprecated_at: string | null;
  created_at: string;
};

export type VerificationIntentRow = {
  id: string;
  request_id: string;
  revision_id: string;
  chw_id: string;
  address_binding_id: string;
  epoch_id: string;
  record_commitment: string;
  schema_version: number;
  idempotency_key: string;
  issued_at: string;
  expires_at: string;
  submitted_at: string | null;
  submitted_transaction_hash: string | null;
  terminal_at: string | null;
};

export type AttestationEvidenceRow = {
  id: string;
  event_id: string;
  intent_id: string;
  transaction_hash: string;
  ledger_sequence: number;
  ledger_hash: string;
  event_index: number;
  observed_at: string;
  finalized_at: string | null;
  invalidated_at: string | null;
  invalidation_reason: string | null;
  created_at: string;
};

export type TrustDecisionRow = {
  revision_id: string;
  state:
    | "unverified"
    | "submitted"
    | "confirming"
    | "verified"
    | "expired"
    | "revoked"
    | "superseded"
    | "conflicted"
    | "unavailable";
  evidence_id: string | null;
  reason_code: string | null;
  decided_at: string;
  finalized_at: string | null;
  updated_at: string;
};

export type PayoutObligationRow = {
  id: string;
  evidence_id: string;
  intent_id: string;
  chw_id: string;
  recipient_address: string;
  amount_usdc: number;
  asset_identifier: string;
  sponsor_pool: string;
  status: "pending" | "settled" | "quarantined" | "adjusted";
  eligibility_key: string;
  created_at: string;
  adjusted_at: string | null;
  adjustment_reason: string | null;
};

export type PayoutSettlementStatus = "matched" | "quarantined";

export type PayoutSettlementRow = {
  id: string;
  obligation_id: string | null;
  transaction_hash: string;
  recipient_address: string;
  amount_usdc: number;
  asset_identifier: string;
  sponsor_pool: string;
  settled_at: string;
  status: PayoutSettlementStatus;
  reason_code: string | null;
  created_at: string;
};

export type ProtocolIndexerCheckpointRow = {
  stream: "attestations" | "payments" | "contract_admin";
  cursor: string;
  ledger_sequence: number | null;
  ledger_hash: string | null;
  updated_at: string;
};

export type AttestationContractAdminEventRow = {
  event_id: string;
  kind:
    | "wasm_upgrade"
    | "admin_transfer"
    | "allowlist_change"
    | "pause"
    | "unpause";
  contract_id: string;
  ledger_sequence: number;
  transaction_hash: string;
  wasm_hash: string | null;
  subject: string | null;
  action: "added" | "removed" | null;
  observed_at: string;
  indexed_at: string;
};

export type AttestationContractTrustStateRow = {
  singleton: boolean;
  state: "trusted" | "needs_review" | "paused";
  wasm_hash: string | null;
  reason_code: string | null;
  updated_at: string;
};

export type ProtocolQuarantineRow = {
  id: string;
  stream: "attestations" | "payments";
  event_id: string;
  reason_code: string;
  attempts: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

/** Return row shape of public.get_emergency_card(p_card_id uuid). */
export type EmergencyCardRow = {
  name: string | null;
  age: number | null;
  photo_url: string | null;
  blood_group: BloodGroup | null;
  genotype: Genotype | null;
  allergies: string[] | null;
  medications: string[] | null;
  chronic_conditions: string[] | null;
  emergency_contacts: EmergencyContact[] | null;
  language: string | null;
  disclosure_states: Record<string, "disclosed" | "withheld" | "pin_required">;
  schema_version: number;
  offline_cache_allowed: boolean;
  trust_state: TrustDecisionRow["state"];
  trust_updated_at: string | null;
  record_updated_at: string;
  authorization_expires_at: string;
};

export type CapabilityEmergencyCardRow = EmergencyCardRow & {
  access_state: "active" | "revoked" | "expired" | "exhausted" | "not_found";
  capability_id: string | null;
};

/** Row shape of public.consent_logs. */
export type ConsentLogRow = {
  id: string;
  user_id: string;
  policy_version: string;
  accepted_at: string;
};

// ---------------------------------------------------------------------------
// Issue #531: Delegated caregiver model
// ---------------------------------------------------------------------------

/** Row shape of public.dependants. */
export type DependantRow = {
  id: string;
  guardian_user_id: string;
  name: string;
  date_of_birth: string | null;
  language: string | null;
  blood_group: string | null;
  genotype: string | null;
  allergies: string[];
  medications: string[];
  chronic_conditions: string[];
  emergency_contacts: EmergencyContact[];
  card_public_id: string;
  created_at: string;
  updated_at: string;
};

export type GuardianshipRole = "primary" | "secondary";

/** Row shape of public.guardianships. */
export type GuardianshipRow = {
  id: string;
  guardian_id: string;
  dependant_profile_id: string;
  role: GuardianshipRole;
  granted_at: string;
  revoked_at: string | null;
};

/** Row shape of public.guardian_audit_log. */
export type GuardianAuditLogRow = {
  id: string;
  actor_id: string;
  subject_id: string;
  action: string;
  meta: Record<string, unknown>;
  occurred_at: string;
};

/** Row shape of public.rate_limits. See lib/rate-limit.ts. */
export type RateLimitRow = {
  key: string;
  attempts: number;
  blocked_until: string | null;
  updated_at: string;
};

/** Return row shape of public.rate_limit_record_failure(p_key text). */
export type RateLimitRecordFailureRow = {
  attempts: number;
  blocked_until: string | null;
};

/** Coarse browser family stored for a session (never a raw user agent). */
export type SessionBrowserFamily =
  | "Chrome"
  | "Edge"
  | "Firefox"
  | "Safari"
  | "Opera"
  | "Samsung Internet"
  | "Other";

/** Coarse OS family stored for a session (never a version or device model). */
export type SessionOsFamily =
  "Android" | "iOS" | "Windows" | "macOS" | "Linux" | "ChromeOS" | "Other";

/** Row shape of public.user_sessions. See lib/sessions/. */
export type UserSessionRow = {
  session_id: string;
  user_id: string;
  browser: SessionBrowserFamily;
  os: SessionOsFamily;
  created_at: string;
  last_seen_at: string;
};

/** Row shape of public.frequency_limits. See lib/frequency-limit.ts. */
export type FrequencyLimitRow = {
  key: string;
  window_start: string;
  count: number;
  /** The p_window_seconds this row's window was opened/last refreshed with (Issue #514). */
  window_seconds: number;
};

export type ChwPayoutStatus = "pending" | "paid";

export type ChwPayoutRow = {
  id: string;
  stellar_address: string;
  chw_id: string | null;
  record_hash: string;
  attested_at: string;
  amount_usdc: number;
  status: ChwPayoutStatus;
  payout_tx_hash: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StellarIndexerCursorRow = {
  stream: "attestations" | "payments";
  cursor: string;
  updated_at: string;
};

export type ChwPayoutObservationRow = {
  record_hash: string;
  stellar_address: string;
  amount_usdc: number;
  payout_tx_hash: string;
  paid_at: string;
  paging_token: string;
  created_at: string;
};

/**
 * Return row shape of
 * public.frequency_limit_check_and_increment(p_key text, p_max_count int,
 * p_window_seconds int).
 */
export type FrequencyLimitCheckAndIncrementRow = {
  allowed: boolean;
  count: number;
  retry_after_seconds: number;
};

/** Return row shape of public.purge_expired_limits(p_batch_size int). See Issue #514. */
export type PurgeExpiredLimitsRow = {
  rate_limits_purged: number;
  frequency_limits_purged: number;
};

/**
 * Matches the shape @supabase/supabase-js's `createClient<Database>()`
 * generic expects, so `.from("profiles")` and `.rpc("get_emergency_card")`
 * are typed without a code-generation step.
 *
 * Must be a `type` alias, not an `interface`: supabase-js's SupabaseClient
 * checks `Schema extends Record<string, GenericTable>`-shaped constraints
 * internally, and TypeScript's structural `extends` check only recognizes
 * plain object type aliases as satisfying an index-signature type like
 * `Record<string, X>` — an `interface` with the same members does not,
 * and silently collapses every query's result type to `never`.
 */
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow> &
          Pick<ProfileRow, "user_id" | "name"> & {
            emergency_contacts?: EmergencyContact[];
          };
        Update: Partial<Omit<ProfileRow, "user_id">>;
        Relationships: [];
      };
      consent_logs: {
        Row: ConsentLogRow;
        Insert: Omit<ConsentLogRow, "id" | "accepted_at"> & {
          id?: string;
          accepted_at?: string;
        };
        Update: Partial<ConsentLogRow>;
        Relationships: [];
      };
      profile_secrets: {
        Row: ProfileSecretRow;
        Insert: Partial<ProfileSecretRow> &
          Pick<ProfileSecretRow, "user_id" | "secret">;
        Update: Partial<Omit<ProfileSecretRow, "user_id">>;
        Relationships: [];
      };
      reattestation_requests: {
        Row: ReattestationRequestRow;
        Insert: Partial<ReattestationRequestRow> &
          Pick<ReattestationRequestRow, "user_id" | "record_hash">;
        Update: Partial<Omit<ReattestationRequestRow, "id">>;
        Relationships: [];
      };
      record_revisions: {
        Row: RecordRevisionRow;
        Insert: Pick<
          RecordRevisionRow,
          | "user_id"
          | "emergency_data"
          | "disclosure_policy"
          | "commitment"
          | "created_by"
        > &
          Partial<RecordRevisionRow>;
        Update: never;
        Relationships: [];
      };
      consent_events: {
        Row: ConsentEventRow;
        Insert: Omit<ConsentEventRow, "id" | "occurred_at"> & {
          id?: string;
          occurred_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      consent_purposes: {
        Row: ConsentPurposeRow;
        Insert: ConsentPurposeRow;
        Update: Partial<ConsentPurposeRow>;
        Relationships: [];
      };
      emergency_capabilities: {
        Row: EmergencyCapabilityRow;
        Insert: Pick<
          EmergencyCapabilityRow,
          | "user_id"
          | "token_digest"
          | "purpose"
          | "field_allowlist"
          | "expires_at"
        > &
          Partial<EmergencyCapabilityRow>;
        Update: never;
        Relationships: [];
      };
      card_access_events: {
        Row: CardAccessEventRow;
        Insert: Pick<
          CardAccessEventRow,
          "user_id" | "access_kind" | "outcome"
        > &
          Partial<CardAccessEventRow>;
        Update: never;
        Relationships: [];
      };
      emergency_contact_notification_events: {
        Row: EmergencyContactNotificationEventRow;
        Insert: Pick<EmergencyContactNotificationEventRow, "user_id"> &
          Partial<EmergencyContactNotificationEventRow>;
        Update: never;
        Relationships: [];
      };
      frequency_limits: {
        Row: FrequencyLimitRow;
        Insert: Pick<FrequencyLimitRow, "key"> & Partial<FrequencyLimitRow>;
        Update: Partial<FrequencyLimitRow>;
        Relationships: [];
      };
      user_sessions: {
        Row: UserSessionRow;
        // Written only through touch_my_session() / revoke_my_session().
        Insert: never;
        Update: never;
        Relationships: [];
      };
      rate_limits: {
        Row: RateLimitRow;
        Insert: Pick<RateLimitRow, "key"> & Partial<RateLimitRow>;
        Update: Partial<RateLimitRow>;
        Relationships: [];
      };
      chw_payouts: {
        Row: ChwPayoutRow;
        Insert: Pick<
          ChwPayoutRow,
          "stellar_address" | "record_hash" | "attested_at"
        > &
          Partial<ChwPayoutRow>;
        Update: Partial<Omit<ChwPayoutRow, "id">>;
        Relationships: [];
      };
      stellar_indexer_cursors: {
        Row: StellarIndexerCursorRow;
        Insert: Pick<StellarIndexerCursorRow, "stream" | "cursor"> &
          Partial<StellarIndexerCursorRow>;
        Update: Partial<Omit<StellarIndexerCursorRow, "stream">>;
        Relationships: [];
      };
      chw_payout_observations: {
        Row: ChwPayoutObservationRow;
        Insert: Omit<ChwPayoutObservationRow, "created_at"> & {
          created_at?: string;
        };
        Update: Partial<ChwPayoutObservationRow>;
        Relationships: [];
      };
      chw_identities: {
        Row: ChwIdentityRow;
        Insert: Pick<ChwIdentityRow, "chw_id"> & Partial<ChwIdentityRow>;
        Update: Partial<Omit<ChwIdentityRow, "chw_id">>;
        Relationships: [];
      };
      chw_address_bindings: {
        Row: ChwAddressBindingRow;
        Insert: Pick<
          ChwAddressBindingRow,
          "chw_id" | "stellar_address" | "ownership_proof_digest"
        > &
          Partial<ChwAddressBindingRow>;
        Update: Partial<Omit<ChwAddressBindingRow, "id">>;
        Relationships: [];
      };
      protocol_epochs: {
        Row: ProtocolEpochRow;
        Insert: Pick<
          ProtocolEpochRow,
          | "schema_version"
          | "network_passphrase_hash"
          | "contract_id"
          | "contract_version"
          | "event_version"
          | "finality_depth"
          | "payout_amount_usdc"
          | "asset_identifier"
          | "sponsor_pool"
        > &
          Partial<ProtocolEpochRow>;
        Update: Partial<Omit<ProtocolEpochRow, "id">>;
        Relationships: [];
      };
      verification_intents: {
        Row: VerificationIntentRow;
        Insert: Omit<VerificationIntentRow, "id" | "issued_at"> & {
          id?: string;
          issued_at?: string;
        };
        Update: Partial<Omit<VerificationIntentRow, "id">>;
        Relationships: [];
      };
      attestation_evidence: {
        Row: AttestationEvidenceRow;
        Insert: Omit<AttestationEvidenceRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<AttestationEvidenceRow, "id">>;
        Relationships: [];
      };
      trust_decisions: {
        Row: TrustDecisionRow;
        Insert: Pick<TrustDecisionRow, "revision_id"> &
          Partial<TrustDecisionRow>;
        Update: Partial<Omit<TrustDecisionRow, "revision_id">>;
        Relationships: [];
      };
      payout_obligations: {
        Row: PayoutObligationRow;
        Insert: Omit<PayoutObligationRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<PayoutObligationRow, "id">>;
        Relationships: [];
      };
      payout_settlements: {
        Row: PayoutSettlementRow;
        Insert: Omit<PayoutSettlementRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<PayoutSettlementRow, "id">>;
        Relationships: [];
      };
      ledger_checkpoints: {
        Row: LedgerCheckpointRow;
        Insert: Partial<LedgerCheckpointRow>;
        Update: Partial<LedgerCheckpointRow>;
        Relationships: [];
      };
      payout_evidence: {
        Row: PayoutEvidenceRow;
        Insert: Omit<PayoutEvidenceRow, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<PayoutEvidenceRow, "id">>;
        Relationships: [];
      };
      conflicting_observations: {
        Row: ConflictingObservationRow;
        Insert: Partial<ConflictingObservationRow>;
        Update: Partial<Omit<ConflictingObservationRow, "id">>;
        Relationships: [];
      };
      protocol_indexer_checkpoints: {
        Row: ProtocolIndexerCheckpointRow;
        Insert: Pick<ProtocolIndexerCheckpointRow, "stream" | "cursor"> &
          Partial<ProtocolIndexerCheckpointRow>;
        Update: Partial<Omit<ProtocolIndexerCheckpointRow, "stream">>;
        Relationships: [];
      };
      attestation_contract_admin_events: {
        Row: AttestationContractAdminEventRow;
        Insert: Omit<AttestationContractAdminEventRow, "indexed_at"> &
          Partial<Pick<AttestationContractAdminEventRow, "indexed_at">>;
        Update: Partial<AttestationContractAdminEventRow>;
        Relationships: [];
      };
      attestation_contract_trust_state: {
        Row: AttestationContractTrustStateRow;
        Insert: Pick<AttestationContractTrustStateRow, "state"> &
          Partial<AttestationContractTrustStateRow>;
        Update: Partial<AttestationContractTrustStateRow>;
        Relationships: [];
      };
      patient_blocking_keys: {
        Row: PatientBlockingKeyRow;
        Insert: Omit<PatientBlockingKeyRow, "updated_at"> &
          Partial<Pick<PatientBlockingKeyRow, "updated_at">>;
        Update: Partial<PatientBlockingKeyRow>;
        Relationships: [];
      };
      account_merge_requests: {
        Row: AccountMergeRequestRow;
        Insert: Pick<
          AccountMergeRequestRow,
          "requester_user_id" | "other_user_id" | "expires_at"
        > &
          Partial<AccountMergeRequestRow>;
        Update: Partial<
          Pick<
            AccountMergeRequestRow,
            "status" | "requester_verified_at" | "other_verified_at"
          >
        >;
        Relationships: [];
      };
      account_merge_audit: {
        Row: AccountMergeAuditRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      account_notification_outbox: {
        Row: AccountNotificationOutboxRow;
        Insert: never;
        Update: Partial<Pick<AccountNotificationOutboxRow, "sent_at">>;
        Relationships: [];
      };
      emergency_capability_pins: {
        Row: EmergencyCapabilityPinRow;
        Insert: Pick<EmergencyCapabilityPinRow, "capability_id" | "pin_hash"> &
          Partial<EmergencyCapabilityPinRow>;
        Update: Partial<Omit<EmergencyCapabilityPinRow, "capability_id">>;
        Relationships: [];
      };
      protocol_quarantine: {
        Row: ProtocolQuarantineRow;
        Insert: Pick<
          ProtocolQuarantineRow,
          "stream" | "event_id" | "reason_code"
        > &
          Partial<ProtocolQuarantineRow>;
        Update: Partial<Omit<ProtocolQuarantineRow, "id">>;
        Relationships: [];
      };
      dependants: {
        Row: DependantRow;
        Insert: Pick<DependantRow, "guardian_user_id" | "name"> &
          Partial<DependantRow>;
        Update: Partial<Omit<DependantRow, "id" | "guardian_user_id">>;
        Relationships: [];
      };
      guardianships: {
        Row: GuardianshipRow;
        Insert: Pick<
          GuardianshipRow,
          "guardian_id" | "dependant_profile_id"
        > &
          Partial<GuardianshipRow>;
        Update: Partial<Omit<GuardianshipRow, "id">>;
        Relationships: [];
      };
      guardian_audit_log: {
        Row: GuardianAuditLogRow;
        Insert: Pick<
          GuardianAuditLogRow,
          "actor_id" | "subject_id" | "action"
        > &
          Partial<GuardianAuditLogRow>;
        Update: never;
        Relationships: [];
      };
    };
    Views: {
      payout_obligation_reconciliation: {
        Row: {
          reporting_day: string;
          obligations: number;
          settled: number;
          pending: number;
          quarantined: number;
          explicitly_adjusted: number;
          reconciled: boolean;
        };
        Relationships: [];
      };
    };
    Functions: {
      get_emergency_card: {
        Args: { p_card_id: string };
        Returns: EmergencyCardRow[];
      };
      consume_emergency_capability: {
        Args: { p_token_digest: string };
        Returns: CapabilityEmergencyCardRow[];
      };
      create_emergency_capability: {
        Args: {
          p_token_digest: string;
          p_purpose: EmergencyCapabilityPurpose;
          p_field_allowlist: Record<string, boolean>;
          p_expires_at: string;
          p_max_views?: number | null;
        };
        Returns: EmergencyCapabilityRow;
      };
      revoke_emergency_capability: {
        Args: { p_capability_id: string };
        Returns: undefined;
      };
      record_card_access_event: {
        Args: {
          p_capability_id: string;
          p_access_kind: "legacy" | "capability";
          p_outcome:
            | "served"
            | "inactive"
            | "pin_success"
            | "pin_failure"
            | "pin_locked";
        };
        Returns: undefined;
      };
      find_user_id_by_email: {
        Args: { p_email: string };
        Returns: string | null;
      };
      count_duplicate_candidates: {
        Args: { p_user_id: string };
        Returns: number;
      };
      accounts_share_blocking_key: {
        Args: { p_a: string; p_b: string };
        Returns: boolean;
      };
      recompute_patient_payout_eligibility: {
        Args: { p_user_id: string };
        Returns: number;
      };
      merge_patient_accounts: {
        Args: { p_merge_request_id: string; p_survivor_user_id: string };
        Returns: AccountMergeAuditRow;
      };
      get_card_pin_gate: {
        Args: { p_capability_id: string; p_unlock_digest: string };
        Returns: {
          gated_fields: string[];
          has_pin: boolean;
          locked: boolean;
          unlocked: boolean;
        }[];
      };
      get_legacy_card_pin_gated_fields: {
        Args: { p_card_id: string };
        Returns: string[];
      };
      set_card_pin: {
        Args: { p_capability_id: string; p_pin_hash: string };
        Returns: undefined;
      };
      begin_card_pin_attempt: {
        Args: { p_token_digest: string };
        Returns: {
          capability_id: string;
          pin_hash: string | null;
          allowed: boolean;
        }[];
      };
      complete_card_pin_success: {
        Args: {
          p_capability_id: string;
          p_unlock_digest: string;
          p_unlock_expires_at: string;
        };
        Returns: undefined;
      };
      get_my_card_pin_access_summary: {
        Args: Record<string, never>;
        Returns: {
          pin_successes_30d: number;
          pin_failures_30d: number;
          last_pin_failure_at: string | null;
        }[];
      };
      record_legacy_card_access_event: {
        Args: { p_card_id: string };
        Returns: undefined;
      };
      get_my_card_access_summary: {
        Args: Record<string, never>;
        Returns: {
          views_last_30_days: number;
          last_viewed_at: string | null;
        }[];
      };
      notify_emergency_contacts: {
        Args: { p_token_digest: string; p_facility_name?: string | null };
        Returns: {
          allowed: boolean;
          reason: string;
          contacts: EmergencyContact[] | null;
          patient_first_name: string | null;
        }[];
      };
      get_my_emergency_contact_notification_summary: {
        Args: Record<string, never>;
        Returns: {
          notifications_last_30_days: number;
          last_sent_at: string | null;
        }[];
      };
      save_record_revision: {
        Args: {
          p_expected_revision_id: string | null;
          p_emergency_data: Record<string, unknown>;
          p_provenance: Record<string, unknown>;
          p_disclosure_policy: DisclosurePolicy;
          p_commitment: string;
        };
        Returns: RecordRevisionRow;
      };
      record_consent: {
        Args: {
          p_purpose: string;
          p_purpose_version: number;
          p_action: string;
          p_idempotency_key: string;
        };
        Returns: ConsentEventRow;
      };
      update_disclosure_policy: {
        Args: {
          p_expected_revision_id: string;
          p_disclosure_policy: DisclosurePolicy;
        };
        Returns: RecordRevisionRow;
      };
      request_revision_verification: {
        Args: { p_expected_revision_id: string };
        Returns: ReattestationRequestRow;
      };
      touch_my_session: {
        Args: { p_browser: SessionBrowserFamily; p_os: SessionOsFamily };
        Returns: boolean;
      };
      revoke_my_session: {
        Args: { p_session_id: string };
        Returns: boolean;
      };
      purge_expired_user_sessions: {
        Args: Record<string, never>;
        Returns: number;
      };
      rate_limit_record_failure: {
        Args: { p_key: string };
        Returns: RateLimitRecordFailureRow[];
      };
      frequency_limit_check_and_increment: {
        Args: {
          p_key: string;
          p_max_count: number;
          p_window_seconds: number;
        };
        Returns: FrequencyLimitCheckAndIncrementRow[];
      };
      purge_expired_limits: {
        Args: { p_batch_size?: number };
        Returns: PurgeExpiredLimitsRow[];
      };
      apply_chw_attestation: {
        Args: {
          p_record_hash: string;
          p_stellar_address: string;
          p_attested_at: string;
        };
        Returns: string;
      };
      apply_chw_payout: {
        Args: {
          p_record_hash: string;
          p_stellar_address: string;
          p_amount_usdc: number;
          p_payout_tx_hash: string;
          p_paid_at: string;
          p_paging_token: string;
        };
        Returns: string;
      };
      claim_verification_request: {
        Args: { p_request_id: string; p_lease_seconds?: number };
        Returns: {
          request_id: string;
          revision_id: string;
          lease_token: string;
          lease_expires_at: string;
          schema_version: number;
          record_commitment: string;
          review_data: Record<string, unknown>;
        }[];
      };
      renew_verification_lease: {
        Args: {
          p_request_id: string;
          p_lease_token: string;
          p_lease_seconds?: number;
        };
        Returns: string;
      };
      release_verification_lease: {
        Args: { p_request_id: string; p_lease_token: string };
        Returns: undefined;
      };
      create_verification_intent: {
        Args: {
          p_request_id: string;
          p_lease_token: string;
          p_epoch_id: string;
          p_idempotency_key: string;
          p_ttl_seconds?: number;
        };
        Returns: VerificationIntentRow;
      };
      mark_verification_intent_submitted: {
        Args: { p_intent_id: string; p_transaction_hash: string };
        Returns: VerificationIntentRow;
      };
      apply_finalized_attestation_evidence: {
        Args: {
          p_event_id: string;
          p_intent_id: string;
          p_record_commitment: string;
          p_attester_address: string;
          p_transaction_hash: string;
          p_ledger_sequence: number;
          p_ledger_hash: string;
          p_event_index: number;
          p_observed_at: string;
          p_finalized_at: string | null;
          p_network_passphrase_hash: string;
          p_contract_id: string;
          p_contract_version: string;
          p_schema_version: number;
          p_idempotency_key: string;
        };
        Returns: TrustDecisionRow;
      };
      reconcile_attestation_reorg: {
        Args: { p_event_id: string; p_reason_code: string };
        Returns: undefined;
      };
      apply_payout_settlement: {
        Args: {
          p_transaction_hash: string;
          p_recipient_address: string;
          p_amount_usdc: number;
          p_asset_identifier: string;
          p_sponsor_pool: string;
          p_settled_at: string;
        };
        Returns: string;
      };
      quarantine_protocol_event: {
        Args: { p_stream: string; p_event_id: string; p_reason_code: string };
        Returns: number;
      };
      can_manage_profile: {
        Args: { p_dependant_id: string };
        Returns: boolean;
      };
      create_dependant: {
        Args: {
          p_name: string;
          p_date_of_birth?: string | null;
          p_language?: string | null;
          p_blood_group?: string | null;
          p_genotype?: string | null;
          p_allergies?: string[];
          p_medications?: string[];
          p_chronic_conditions?: string[];
          p_emergency_contacts?: Record<string, unknown>[];
        };
        Returns: DependantRow;
      };
      update_dependant: {
        Args: {
          p_dependant_id: string;
          p_name?: string | null;
          p_date_of_birth?: string | null;
          p_language?: string | null;
          p_blood_group?: string | null;
          p_genotype?: string | null;
          p_allergies?: string[] | null;
          p_medications?: string[] | null;
          p_chronic_conditions?: string[] | null;
          p_emergency_contacts?: Record<string, unknown>[] | null;
        };
        Returns: DependantRow;
      };
      delete_dependant: {
        Args: { p_dependant_id: string };
        Returns: undefined;
      };
      get_my_dependants: {
        Args: Record<string, never>;
        Returns: DependantRow[];
      };
    };
    Enums: {
      blood_group_enum: BloodGroup;
      chw_payout_status: ChwPayoutStatus;
      genotype_enum: Genotype;
      payout_settlement_status: PayoutSettlementStatus;
      record_lifecycle_state: RecordLifecycleState;
    };
  };
};
