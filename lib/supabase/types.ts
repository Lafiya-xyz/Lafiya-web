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
};

export type DisclosurePolicy = {
  version: 1;
  fields: Record<string, boolean>;
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
  | "optional_analytics";

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
  | "under_review"
  | "submitted"
  | "confirming"
  | "completed"
  | "dismissed"
  | "superseded";

/** Row shape of public.reattestation_requests. */
export type ReattestationRequestRow = {
  id: string;
  user_id: string;
  record_hash: string;
  requested_at: string;
  status: ReattestationRequestStatus;
  revision_id: string | null;
  claimed_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  released_at: string | null;
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
  disclosure_states: Record<string, "disclosed" | "withheld">;
  revision_id: string;
  schema_version: number;
  commitment: string;
  trust_status:
    | "unverified"
    | "submitted"
    | "confirming"
    | "verified"
    | "expired"
    | "revoked"
    | "superseded"
    | "conflicted"
    | "unavailable";
  offline_cache_allowed: boolean;
};

/** Row shape of public.consent_logs. */
export type ConsentLogRow = {
  id: string;
  user_id: string;
  policy_version: string;
  accepted_at: string;
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

/** Row shape of public.frequency_limits. See lib/frequency-limit.ts. */
export type FrequencyLimitRow = {
  key: string;
  window_start: string;
  count: number;
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

export type ChwIdentityStatus =
  "pending" | "active" | "suspended" | "rotating" | "recovering" | "offboarded";

export type ChwIdentityRow = {
  chw_id: string;
  stellar_address: string;
  status: ChwIdentityStatus;
  credential_expires_at: string | null;
  proof_challenge: string;
  proof_signature: string;
  bound_at: string | null;
  status_updated_at: string;
  status_updated_by: string | null;
  recovery_nonce: string;
  created_at: string;
};

export type AttestationContractEpochRow = {
  id: string;
  network_passphrase_hash: string;
  contract_id: string;
  contract_version: string;
  schema_version: number;
  minimum_finality_depth: number;
  active: boolean;
  starts_at: string;
  ends_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type VerificationSubmissionRow = {
  id: string;
  request_id: string;
  revision_id: string;
  chw_id: string;
  stellar_address: string;
  contract_epoch_id: string;
  idempotency_key: string;
  intent_hash: string;
  intent_payload: Record<string, unknown>;
  intent_signature: string;
  intent_expires_at: string;
  submitted_at: string;
  status: "submitted" | "confirming" | "accepted" | "rejected" | "superseded";
  rejection_code: string | null;
};

export type PayoutObligationRow = {
  id: string;
  submission_id: string;
  recipient_chw_id: string;
  recipient_stellar_address: string;
  amount: number;
  amount_version: string;
  asset_code: string;
  asset_issuer: string;
  sponsor_pool_address: string;
  status: "pending" | "settled" | "quarantined" | "adjusted" | "reversed";
  manual_review_reason: string | null;
  created_at: string;
  settled_at: string | null;
  settlement_tx_hash: string | null;
};

export type VerificationTrustEventRow = {
  id: string;
  submission_id: string;
  revision_id: string;
  decision:
    | "unverified"
    | "submitted"
    | "confirming"
    | "verified"
    | "expired"
    | "revoked"
    | "superseded"
    | "conflicted"
    | "unavailable";
  transaction_hash: string | null;
  ledger_sequence: number | null;
  ledger_hash: string | null;
  event_position: number | null;
  observed_at: string;
  finalized_at: string | null;
  finality_depth: number | null;
  evidence: Record<string, unknown>;
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
      frequency_limits: {
        Row: FrequencyLimitRow;
        Insert: Pick<FrequencyLimitRow, "key"> & Partial<FrequencyLimitRow>;
        Update: Partial<FrequencyLimitRow>;
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
        Insert: Pick<
          ChwIdentityRow,
          | "chw_id"
          | "stellar_address"
          | "proof_challenge"
          | "proof_signature"
          | "recovery_nonce"
        > &
          Partial<ChwIdentityRow>;
        Update: Partial<Omit<ChwIdentityRow, "chw_id">>;
        Relationships: [];
      };
      attestation_contract_epochs: {
        Row: AttestationContractEpochRow;
        Insert: Pick<
          AttestationContractEpochRow,
          | "network_passphrase_hash"
          | "contract_id"
          | "contract_version"
          | "schema_version"
          | "minimum_finality_depth"
        > &
          Partial<AttestationContractEpochRow>;
        Update: Partial<Omit<AttestationContractEpochRow, "id">>;
        Relationships: [];
      };
      verification_submissions: {
        Row: VerificationSubmissionRow;
        Insert: Omit<VerificationSubmissionRow, "id" | "submitted_at"> & {
          id?: string;
          submitted_at?: string;
        };
        Update: Partial<Omit<VerificationSubmissionRow, "id">>;
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
      verification_trust_events: {
        Row: VerificationTrustEventRow;
        Insert: Omit<
          VerificationTrustEventRow,
          "id" | "observed_at" | "created_at"
        > & {
          id?: string;
          observed_at?: string;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_emergency_card: {
        Args: { p_card_id: string };
        Returns: EmergencyCardRow[];
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
        Args: { p_chw_id: string; p_lease_seconds?: number };
        Returns: {
          request_id: string;
          revision_id: string;
          record_hash: string;
          lease_token: string;
          lease_expires_at: string;
        }[];
      };
      renew_verification_lease: {
        Args: {
          p_request_id: string;
          p_chw_id: string;
          p_lease_token: string;
          p_lease_seconds?: number;
        };
        Returns: string;
      };
      release_verification_lease: {
        Args: { p_request_id: string; p_chw_id: string; p_lease_token: string };
        Returns: undefined;
      };
      record_verification_submission: {
        Args: {
          p_request_id: string;
          p_chw_id: string;
          p_lease_token: string;
          p_contract_epoch_id: string;
          p_idempotency_key: string;
          p_intent_hash: string;
          p_intent_payload: Record<string, unknown>;
          p_intent_signature: string;
          p_intent_expires_at: string;
        };
        Returns: VerificationSubmissionRow;
      };
      finalize_verification_trust: {
        Args: {
          p_submission_id: string;
          p_decision: string;
          p_transaction_hash: string | null;
          p_ledger_sequence: number | null;
          p_ledger_hash: string | null;
          p_event_position: number | null;
          p_finality_depth: number | null;
          p_finalized_at: string | null;
          p_evidence: Record<string, unknown>;
          p_amount: number;
          p_amount_version: string;
          p_asset_code: string;
          p_asset_issuer: string;
          p_sponsor_pool_address: string;
        };
        Returns: VerificationTrustEventRow;
      };
    };
    Enums: {
      blood_group_enum: BloodGroup;
      genotype_enum: Genotype;
      record_lifecycle_state: RecordLifecycleState;
    };
  };
};
