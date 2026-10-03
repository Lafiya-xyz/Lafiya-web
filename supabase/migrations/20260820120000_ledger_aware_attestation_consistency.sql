-- Ledger-aware attestation consistency and reorganization handling.
-- Persists ledger checkpoints and transaction evidence to protect against
-- provider lag, duplicate events, and rollback/reorg scenarios.

-- Ledger checkpoint: tracks the highest confirmed ledger and paging token per stream.
-- Used to detect provider disagreement (a gap or reorg) and enforce finality.
create table public.ledger_checkpoints (
  stream text primary key check (stream in ('attestations', 'payments')),
  -- Highest ledger number successfully applied and confirmed
  ledger_number bigint not null,
  -- Paging token or cursor at this ledger (for recovery/restart)
  cursor text not null,
  -- ISO timestamp of the last successful apply
  confirmed_at timestamptz not null default now(),
  -- Transaction hash of the last event applied (for dedup awareness)
  last_tx_hash text,
  updated_at timestamptz not null default now()
);

comment on table public.ledger_checkpoints is
  'Tracks confirmed ledger boundaries and last transaction per stream. Used to detect reorgs, enforce finality, and enable deterministic recovery from known checkpoints.';

-- Ledger attestation evidence: persists the ledger proof for each accepted attestation.
-- Enables audit trail, reconciliation, and replay safety.
--
-- NOTE: This is the legacy, ledger-keyed evidence table. The canonical
-- `public.attestation_evidence` table is defined by the protocol-v1 migration
-- (20260821150000_chw_verification_protocol.sql) and is keyed on
-- event_id/intent_id/ledger_sequence/ledger_hash. This table is intentionally
-- named `ledger_attestation_evidence` so that a fresh `supabase db reset` can
-- apply both migrations without a duplicate-table conflict. See
-- docs/adr/0001-canonical-attestation-evidence-model.md for the migration path.
create table public.ledger_attestation_evidence (
  id uuid primary key default gen_random_uuid(),
  record_hash text not null,
  stellar_address text not null,
  -- Ledger and transaction from the Soroban contract call
  ledger_number bigint not null,
  transaction_hash text not null unique,
  attested_at timestamptz not null,
  -- Observation ID from the apply decision (pending/paid_from_observation/etc)
  decision text not null,
  -- ISO timestamp of when evidence was recorded
  evidence_recorded_at timestamptz not null default now(),
  -- Checksum of all evidence fields for integrity checks
  evidence_checksum text not null,
  created_at timestamptz not null default now(),
  unique (record_hash, transaction_hash)
);

create index ledger_attestation_evidence_record_hash_idx on public.ledger_attestation_evidence (record_hash);
create index ledger_attestation_evidence_ledger_idx on public.ledger_attestation_evidence (ledger_number);

comment on table public.ledger_attestation_evidence is
  'Immutable evidence log of accepted attestations with full ledger proof. Enables reconciliation of conflicting observations and deterministic replay.';

-- Payout decision evidence: persists the ledger proof for each accepted payout.
-- Mirrors ledger_attestation_evidence structure for symmetry and cross-stream reconciliation.
create table public.payout_evidence (
  id uuid primary key default gen_random_uuid(),
  record_hash text not null,
  stellar_address text not null,
  -- Horizon paging token and ledger from the payment operation
  ledger_number bigint,
  transaction_hash text not null unique,
  paging_token text not null unique,
  amount_usdc numeric(20, 7) not null,
  paid_at timestamptz not null,
  -- Observation ID from the apply decision
  decision text not null,
  -- ISO timestamp of when evidence was recorded
  evidence_recorded_at timestamptz not null default now(),
  -- Checksum for integrity checks
  evidence_checksum text not null,
  created_at timestamptz not null default now(),
  unique (record_hash, transaction_hash)
);

create index payout_evidence_record_hash_idx on public.payout_evidence (record_hash);
create index payout_evidence_paging_token_idx on public.payout_evidence (paging_token);

comment on table public.payout_evidence is
  'Immutable evidence log of accepted payouts with full Horizon proof. Enables cross-stream consistency checks and deterministic replay.';

-- Conflicting observations: recorded when a record is observed in inconsistent states
-- (e.g., revoked attestation, address mismatch, reorg). Operators use this to identify
-- and reconcile records that diverged silently.
create table public.conflicting_observations (
  id uuid primary key default gen_random_uuid(),
  record_hash text not null,
  -- Type of conflict: 'revoked_attestation', 'address_mismatch', 'reorg_detected', 'provider_disagreement', 'duplicate_payout'
  conflict_type text not null check (
    conflict_type in (
      'revoked_attestation',
      'address_mismatch',
      'reorg_detected',
      'provider_disagreement',
      'duplicate_payout',
      'stale_cache',
      'checksum_mismatch'
    )
  ),
  -- Evidence from both sides of the conflict (JSON for flexibility)
  previous_state jsonb,
  current_state jsonb,
  detected_at timestamptz not null default now(),
  -- Whether the conflict has been manually reviewed and resolved
  resolved boolean not null default false,
  resolution_notes text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index conflicting_observations_record_hash_idx on public.conflicting_observations (record_hash);
create index conflicting_observations_type_idx on public.conflicting_observations (conflict_type);
create index conflicting_observations_resolved_idx on public.conflicting_observations (resolved);

comment on table public.conflicting_observations is
  'Audit trail of detected inconsistencies. Operators use this to identify silently diverged records and manually reconcile.';

-- RLS and access control
alter table public.ledger_checkpoints enable row level security;
alter table public.ledger_attestation_evidence enable row level security;
alter table public.payout_evidence enable row level security;
alter table public.conflicting_observations enable row level security;

revoke all on public.ledger_checkpoints from anon, authenticated;
revoke all on public.ledger_attestation_evidence from anon, authenticated;
revoke all on public.payout_evidence from anon, authenticated;
revoke all on public.conflicting_observations from anon, authenticated;

grant select, insert, update, delete on public.ledger_checkpoints to service_role;
grant select, insert, update, delete on public.ledger_attestation_evidence to service_role;
grant select, insert, update, delete on public.payout_evidence to service_role;
grant select, insert, update, delete on public.conflicting_observations to service_role;

-- Enhanced apply functions with ledger awareness and conflict detection.

/**
 * get_ledger_checkpoint: fetch the current checkpoint for a stream.
 * Returns null if no checkpoint exists yet (first run).
 */
create or replace function public.get_ledger_checkpoint(
  p_stream text
)
returns table (
  ledger_number bigint,
  cursor text,
  confirmed_at timestamptz,
  last_tx_hash text
)
language sql
security definer
set search_path = ''
as $$
  select lc.ledger_number, lc.cursor, lc.confirmed_at, lc.last_tx_hash
  from public.ledger_checkpoints lc
  where lc.stream = p_stream;
$$;

/**
 * update_ledger_checkpoint: atomically update the checkpoint after a successful apply batch.
 * Used by the indexer after all events in a page are applied.
 */
create or replace function public.update_ledger_checkpoint(
  p_stream text,
  p_ledger_number bigint,
  p_cursor text,
  p_last_tx_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.ledger_checkpoints (stream, ledger_number, cursor, confirmed_at, last_tx_hash, updated_at)
  values (p_stream, p_ledger_number, p_cursor, now(), p_last_tx_hash, now())
  on conflict (stream) do update
    set ledger_number = excluded.ledger_number,
        c

/* … truncated 2327 chars — edit only what you need near the top … */
