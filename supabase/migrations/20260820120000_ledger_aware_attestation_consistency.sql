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

-- Attestation decision evidence: persists the ledger proof for each accepted attestation.
-- Enables audit trail, reconciliation, and replay safety.
create table public.attestation_evidence (
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

create index attestation_evidence_record_hash_idx on public.attestation_evidence (record_hash);
create index attestation_evidence_ledger_idx on public.attestation_evidence (ledger_number);

comment on table public.attestation_evidence is
  'Immutable evidence log of accepted attestations with full ledger proof. Enables reconciliation of conflicting observations and deterministic replay.';

-- Payout decision evidence: persists the ledger proof for each accepted payout.
-- Mirrors attestation_evidence structure for symmetry and cross-stream reconciliation.
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
alter table public.attestation_evidence enable row level security;
alter table public.payout_evidence enable row level security;
alter table public.conflicting_observations enable row level security;

revoke all on public.ledger_checkpoints from anon, authenticated;
revoke all on public.attestation_evidence from anon, authenticated;
revoke all on public.payout_evidence from anon, authenticated;
revoke all on public.conflicting_observations from anon, authenticated;

grant select, insert, update, delete on public.ledger_checkpoints to service_role;
grant select, insert, update, delete on public.attestation_evidence to service_role;
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
        cursor = excluded.cursor,
        confirmed_at = excluded.confirmed_at,
        last_tx_hash = excluded.last_tx_hash,
        updated_at = excluded.updated_at;
end;
$$;

/**
 * detect_ledger_reorg: check if the current event's ledger is lower than the last confirmed.
 * Returns true if a reorg or provider disagreement is suspected.
 */
create or replace function public.detect_ledger_reorg(
  p_stream text,
  p_new_ledger bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  confirmed_ledger bigint;
begin
  select lc.ledger_number into confirmed_ledger
  from public.ledger_checkpoints lc
  where lc.stream = p_stream;

  -- No checkpoint yet: safe to proceed
  if not found then
    return false;
  end if;

  -- New ledger is lower than confirmed: reorg detected
  return p_new_ledger < confirmed_ledger;
end;
$$;

/**
 * record_attestation_evidence: idempotent recording of attestation decision evidence.
 * Computes checksum, detects duplicates, logs conflicts.
 */
create or replace function public.record_attestation_evidence(
  p_record_hash text,
  p_stellar_address text,
  p_ledger_number bigint,
  p_transaction_hash text,
  p_attested_at timestamptz,
  p_decision text
)
returns table (
  success boolean,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  checksum text;
  existing_evidence record;
begin
  -- Compute checksum of evidence (used for integrity checks)
  checksum := md5(
    p_record_hash || ':' || p_stellar_address || ':' || 
    p_ledger_number::text || ':' || p_transaction_hash || ':' || 
    p_attested_at::text || ':' || p_decision
  );

  -- Check for existing evidence
  select * into existing_evidence
  from public.attestation_evidence ae
  where ae.record_hash = p_record_hash
    and ae.transaction_hash = p_transaction_hash;

  if found then
    -- Duplicate detected
    if existing_evidence.evidence_checksum = checksum then
      -- Exact duplicate, idempotent
      return query select true, 'idempotent_duplicate'::text;
    else
      -- Conflict: same tx but different evidence (should not happen, indicates corruption)
      insert into public.conflicting_observations 
        (record_hash, conflict_type, previous_state, current_state)
      values 
        (p_record_hash, 'checksum_mismatch',
         jsonb_build_object(
           'ledger', existing_evidence.ledger_number,
           'attested_at', existing_evidence.attested_at,
           'decision', existing_evidence.decision
         ),
         jsonb_build_object(
           'ledger', p_ledger_number,
           'attested_at', p_attested_at,
           'decision', p_decision
         ));
      return query select false, 'checksum_mismatch_conflict'::text;
    end if;
  end if;

  -- New evidence: record it
  insert into public.attestation_evidence 
    (record_hash, stellar_address, ledger_number, transaction_hash, attested_at, decision, evidence_checksum)
  values 
    (p_record_hash, p_stellar_address, p_ledger_number, p_transaction_hash, p_attested_at, p_decision, checksum);

  return query select true, 'recorded'::text;
end;
$$;

/**
 * record_payout_evidence: idempotent recording of payout decision evidence.
 * Mirrors attestation_evidence logic.
 */
create or replace function public.record_payout_evidence(
  p_record_hash text,
  p_stellar_address text,
  p_ledger_number bigint,
  p_transaction_hash text,
  p_paging_token text,
  p_amount_usdc numeric,
  p_paid_at timestamptz,
  p_decision text
)
returns table (
  success boolean,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  checksum text;
  existing_evidence record;
begin
  checksum := md5(
    p_record_hash || ':' || p_stellar_address || ':' ||
    p_transaction_hash || ':' || p_paging_token || ':' ||
    p_amount_usdc::text || ':' || p_paid_at::text || ':' || p_decision
  );

  select * into existing_evidence
  from public.payout_evidence pe
  where pe.record_hash = p_record_hash
    and pe.transaction_hash = p_transaction_hash;

  if found then
    if existing_evidence.evidence_checksum = checksum then
      return query select true, 'idempotent_duplicate'::text;
    else
      insert into public.conflicting_observations
        (record_hash, conflict_type, previous_state, current_state)
      values
        (p_record_hash, 'duplicate_payout',
         jsonb_build_object(
           'amount', existing_evidence.amount_usdc,
           'paid_at', existing_evidence.paid_at,
           'decision', existing_evidence.decision
         ),
         jsonb_build_object(
           'amount', p_amount_usdc,
           'paid_at', p_paid_at,
           'decision', p_decision
         ));
      return query select false, 'duplicate_payout_conflict'::text;
    end if;
  end if;

  insert into public.payout_evidence
    (record_hash, stellar_address, ledger_number, transaction_hash, paging_token, amount_usdc, paid_at, decision, evidence_checksum)
  values
    (p_record_hash, p_stellar_address, p_ledger_number, p_transaction_hash, p_paging_token, p_amount_usdc, p_paid_at, p_decision, checksum);

  return query select true, 'recorded'::text;
end;
$$;

/**
 * reconcile_conflicting_record: operator-facing function to review and resolve a conflicted record.
 * Marks the conflict as resolved with notes.
 */
create or replace function public.reconcile_conflicting_record(
  p_conflict_id uuid,
  p_resolution_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conflicting_observations
  set resolved = true,
      resolution_notes = p_resolution_notes,
      resolved_at = now()
  where id = p_conflict_id;
end;
$$;

-- Expose functions to service_role
revoke all on function public.get_ledger_checkpoint(text) from public;
revoke all on function public.update_ledger_checkpoint(text, bigint, text, text) from public;
revoke all on function public.detect_ledger_reorg(text, bigint) from public;
revoke all on function public.record_attestation_evidence(text, text, bigint, text, timestamptz, text) from public;
revoke all on function public.record_payout_evidence(text, text, bigint, text, text, numeric, timestamptz, text) from public;
revoke all on function public.reconcile_conflicting_record(uuid, text) from public;

grant execute on function public.get_ledger_checkpoint(text) to service_role;
grant execute on function public.update_ledger_checkpoint(text, bigint, text, text) to service_role;
grant execute on function public.detect_ledger_reorg(text, bigint) to service_role;
grant execute on function public.record_attestation_evidence(text, text, bigint, text, timestamptz, text) to service_role;
grant execute on function public.record_payout_evidence(text, text, bigint, text, text, numeric, timestamptz, text) to service_role;
grant execute on function public.reconcile_conflicting_record(uuid, text) to service_role;
