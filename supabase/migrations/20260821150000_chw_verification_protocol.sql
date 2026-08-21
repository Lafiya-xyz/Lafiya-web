-- Issue #172: CHW verification, trust evidence, and incentive accounting.
--
-- This migration intentionally keeps clinical data in record_revisions. Queue,
-- intent, ledger, payout, checkpoint, and quarantine rows contain protocol
-- metadata only. They are service-role-only except for the narrowly-scoped
-- SECURITY DEFINER CHW workflow functions below.

create type public.chw_identity_status as enum (
  'pending', 'active', 'suspended', 'rotating', 'recovering', 'offboarded'
);
create type public.protocol_epoch_status as enum ('active', 'deprecated', 'retired');
create type public.trust_decision_state as enum (
  'unverified', 'submitted', 'confirming', 'verified', 'expired', 'revoked',
  'superseded', 'conflicted', 'unavailable'
);
create type public.payout_obligation_status as enum (
  'pending', 'settled', 'quarantined', 'adjusted'
);

create table public.chw_identities (
  chw_id uuid primary key references auth.users(id) on delete restrict,
  status public.chw_identity_status not null default 'pending',
  credential_expires_at timestamptz,
  approved_at timestamptz,
  suspended_at timestamptz,
  status_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chw_active_requires_approval check (
    status <> 'active' or approved_at is not null
  )
);

create table public.chw_address_bindings (
  id uuid primary key default gen_random_uuid(),
  chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  stellar_address text not null check (stellar_address ~ '^G[A-Z2-7]{55}$'),
  ownership_proof_digest text not null check (ownership_proof_digest ~ '^[0-9a-f]{64}$'),
  allowlist_synced_at timestamptz,
  bound_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  approved_by uuid references auth.users(id) on delete set null,
  unique (stellar_address, bound_at)
);
create unique index chw_address_bindings_one_current_address
  on public.chw_address_bindings(chw_id) where revoked_at is null;
create index chw_address_bindings_active_address_idx
  on public.chw_address_bindings(stellar_address) where revoked_at is null;

create table public.protocol_epochs (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null check (schema_version > 0),
  network_passphrase_hash text not null check (network_passphrase_hash ~ '^[0-9a-f]{64}$'),
  contract_id text not null check (contract_id ~ '^C[A-Z2-7]{55}$'),
  contract_version text not null check (length(contract_version) <= 64),
  event_version integer not null check (event_version > 0),
  finality_depth integer not null check (finality_depth >= 1 and finality_depth <= 10000),
  payout_amount_usdc numeric(20,7) not null check (payout_amount_usdc >= 0),
  asset_identifier text not null check (length(asset_identifier) between 3 and 256),
  sponsor_pool text not null check (sponsor_pool ~ '^G[A-Z2-7]{55}$'),
  status public.protocol_epoch_status not null default 'active',
  activated_at timestamptz not null default now(),
  deprecated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (network_passphrase_hash, contract_id, contract_version, schema_version, event_version)
);
create unique index protocol_epochs_one_active
  on public.protocol_epochs(status) where status = 'active';

-- `under_review` was an earlier patient-only placeholder state. It had no
-- claimant or lease, so preserving it as an active claim would be unsafe.
update public.reattestation_requests set status = 'pending' where status = 'under_review';

alter table public.reattestation_requests
  drop constraint reattestation_requests_status_check,
  add constraint reattestation_requests_status_check check (status in (
    'pending', 'leased', 'submitted', 'confirming', 'completed', 'dismissed',
    'superseded', 'failed'
  )),
  add column claimed_chw_id uuid references public.chw_identities(chw_id) on delete restrict,
  add column claimed_address_binding_id uuid references public.chw_address_bindings(id) on delete restrict,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column reviewed_at timestamptz,
  add column review_outcome text check (review_outcome in ('approved', 'rejected'));
create index reattestation_requests_claimable_idx
  on public.reattestation_requests(status, requested_at)
  where status in ('pending', 'leased');
create unique index reattestation_requests_lease_token_unique
  on public.reattestation_requests(lease_token) where lease_token is not null;

create table public.verification_intents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.reattestation_requests(id) on delete restrict,
  revision_id uuid not null references public.record_revisions(id) on delete restrict,
  chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  address_binding_id uuid not null references public.chw_address_bindings(id) on delete restrict,
  epoch_id uuid not null references public.protocol_epochs(id) on delete restrict,
  record_commitment text not null check (record_commitment ~ '^[0-9a-f]{64}$'),
  schema_version integer not null check (schema_version > 0),
  idempotency_key uuid not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  submitted_transaction_hash text unique,
  terminal_at timestamptz,
  constraint verification_intents_expiry check (expires_at > issued_at),
  constraint verification_intents_identity_idempotency_unique unique (chw_id, idempotency_key)
);
create unique index verification_intents_one_open_request
  on public.verification_intents(request_id) where terminal_at is null;
create index verification_intents_revision_idx on public.verification_intents(revision_id);

create table public.attestation_evidence (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique check (length(event_id) between 1 and 256),
  intent_id uuid not null unique references public.verification_intents(id) on delete restrict,
  transaction_hash text not null unique check (length(transaction_hash) between 1 and 256),
  ledger_sequence bigint not null check (ledger_sequence > 0),
  ledger_hash text not null check (length(ledger_hash) between 1 and 256),
  event_index integer not null check (event_index >= 0),
  observed_at timestamptz not null,
  finalized_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default now(),
  constraint attestation_evidence_finality check (
    (finalized_at is null or finalized_at >= observed_at)
    and (invalidated_at is null or invalidated_at >= observed_at)
  )
);
create unique index attestation_evidence_ledger_event_unique
  on public.attestation_evidence(ledger_sequence, ledger_hash, event_index);

create table public.trust_decisions (
  revision_id uuid primary key references public.record_revisions(id) on delete restrict,
  state public.trust_decision_state not null default 'unverified',
  evidence_id uuid references public.attestation_evidence(id) on delete restrict,
  reason_code text,
  decided_at timestamptz not null default now(),
  finalized_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.payout_obligations (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null unique references public.attestation_evidence(id) on delete restrict,
  intent_id uuid not null unique references public.verification_intents(id) on delete restrict,
  chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  recipient_address text not null check (recipient_address ~ '^G[A-Z2-7]{55}$'),
  amount_usdc numeric(20,7) not null check (amount_usdc >= 0),
  asset_identifier text not null,
  sponsor_pool text not null check (sponsor_pool ~ '^G[A-Z2-7]{55}$'),
  status public.payout_obligation_status not null default 'pending',
  eligibility_key text not null unique check (eligibility_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  adjusted_at timestamptz,
  adjustment_reason text
);
create index payout_obligations_status_idx on public.payout_obligations(status, created_at);
create index payout_obligations_chw_idx on public.payout_obligations(chw_id, created_at desc);

create table public.payout_settlements (
  id uuid primary key default gen_random_uuid(),
  obligation_id uuid references public.payout_obligations(id) on delete restrict,
  transaction_hash text not null unique check (length(transaction_hash) between 1 and 256),
  recipient_address text not null check (recipient_address ~ '^G[A-Z2-7]{55}$'),
  amount_usdc numeric(20,7) not null check (amount_usdc >= 0),
  asset_identifier text not null,
  sponsor_pool text not null check (sponsor_pool ~ '^G[A-Z2-7]{55}$'),
  settled_at timestamptz not null,
  status text not null check (status in ('matched', 'quarantined')),
  reason_code text,
  created_at timestamptz not null default now()
);
create unique index payout_settlements_matched_obligation_unique
  on public.payout_settlements(obligation_id) where status = 'matched';

create table public.protocol_quarantine (
  id uuid primary key default gen_random_uuid(),
  stream text not null check (stream in ('attestations', 'payments')),
  event_id text not null,
  reason_code text not null,
  attempts integer not null default 1 check (attempts > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (stream, event_id)
);

create table public.protocol_indexer_checkpoints (
  stream text primary key check (stream in ('attestations', 'payments')),
  cursor text not null,
  ledger_sequence bigint,
  ledger_hash text,
  updated_at timestamptz not null default now(),
  constraint protocol_indexer_checkpoint_ledger_pair check (
    (ledger_sequence is null and ledger_hash is null)
    or (ledger_sequence is not null and ledger_hash is not null)
  )
);

alter table public.chw_identities enable row level security;
alter table public.chw_address_bindings enable row level security;
alter table public.protocol_epochs enable row level security;
alter table public.verification_intents enable row level security;
alter table public.attestation_evidence enable row level security;
alter table public.trust_decisions enable row level security;
alter table public.payout_obligations enable row level security;
alter table public.payout_settlements enable row level security;
alter table public.protocol_quarantine enable row level security;
alter table public.protocol_indexer_checkpoints enable row level security;

-- Direct table access is prohibited. An authenticated CHW interacts through
-- the functions below; ledger/indexer writes require the service role.
revoke all on public.chw_identities, public.chw_address_bindings, public.protocol_epochs,
  public.verification_intents, public.attestation_evidence, public.trust_decisions,
  public.payout_obligations, public.payout_settlements, public.protocol_quarantine,
  public.protocol_indexer_checkpoints from anon, authenticated;
grant select, insert, update, delete on public.chw_identities, public.chw_address_bindings,
  public.protocol_epochs, public.verification_intents, public.attestation_evidence,
  public.trust_decisions, public.payout_obligations, public.payout_settlements,
  public.protocol_quarantine, public.protocol_indexer_checkpoints to service_role;

create function public.claim_verification_request(
  p_request_id uuid,
  p_lease_seconds integer default 300
) returns table (
  request_id uuid,
  revision_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  schema_version integer,
  record_commitment text,
  review_data jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_chw public.chw_identities;
  v_binding public.chw_address_bindings;
  v_request public.reattestation_requests;
  v_revision public.record_revisions;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if p_lease_seconds < 60 or p_lease_seconds > 1800 then raise exception using errcode = '22023', message = 'INVALID_LEASE_DURATION'; end if;
  select * into v_chw from public.chw_identities where chw_id = auth.uid();
  if not found then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;
  if v_chw.status = 'suspended' then raise exception using errcode = '42501', message = 'CHW_SUSPENDED'; end if;
  if v_chw.status <> 'active' then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;
  if v_chw.credential_expires_at is not null and v_chw.credential_expires_at <= now() then raise exception using errcode = '42501', message = 'CHW_CREDENTIAL_EXPIRED'; end if;
  select * into v_binding from public.chw_address_bindings
    where chw_id = auth.uid() and revoked_at is null and allowlist_synced_at is not null;
  if not found then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;

  select * into v_request from public.reattestation_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'REQUEST_NOT_FOUND'; end if;
  select * into v_revision from public.record_revisions where id = v_request.revision_id;
  if not found or not exists (
    select 1 from public.profiles p where p.user_id = v_request.user_id and p.current_revision_id = v_request.revision_id
  ) then
    update public.reattestation_requests set status = 'superseded' where id = p_request_id;
    raise exception using errcode = '23514', message = 'REQUEST_NOT_CURRENT';
  end if;
  if v_request.status = 'leased' and v_request.lease_expires_at > now() then
    raise exception using errcode = '23505', message = 'REQUEST_ALREADY_CLAIMED';
  end if;
  if v_request.status not in ('pending', 'leased') then
    raise exception using errcode = '23514', message = 'REQUEST_NOT_CURRENT';
  end if;

  update public.reattestation_requests set
    status = 'leased', claimed_chw_id = auth.uid(), claimed_address_binding_id = v_binding.id,
    lease_token = gen_random_uuid(), lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_request_id
  returning id, revision_id, lease_token, lease_expires_at into request_id, revision_id, lease_token, lease_expires_at;
  schema_version := v_revision.schema_version;
  record_commitment := v_revision.commitment;
  select coalesce(jsonb_object_agg(field, value), '{}'::jsonb) into review_data
    from jsonb_each(v_revision.emergency_data) as data(field, value)
    where coalesce((v_revision.disclosure_policy #>> array['fields', field])::boolean, false);
  return next;
end;
$$;

create function public.renew_verification_lease(
  p_request_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 300
) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare v_expiry timestamptz;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if p_lease_seconds < 60 or p_lease_seconds > 1800 then raise exception using errcode = '22023', message = 'INVALID_LEASE_DURATION'; end if;
  update public.reattestation_requests set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    where id = p_request_id and status = 'leased' and claimed_chw_id = auth.uid()
      and lease_token = p_lease_token and lease_expires_at > now()
    returning lease_expires_at into v_expiry;
  if not found then raise exception using errcode = '40001', message = 'LEASE_EXPIRED'; end if;
  return v_expiry;
end;
$$;

create function public.release_verification_lease(
  p_request_id uuid,
  p_lease_token uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  update public.reattestation_requests set status = 'pending', claimed_chw_id = null,
    claimed_address_binding_id = null, lease_token = null, lease_expires_at = null
    where id = p_request_id and status = 'leased' and claimed_chw_id = auth.uid()
      and lease_token = p_lease_token;
  if not found then raise exception using errcode = '42501', message = 'LEASE_NOT_OWNER'; end if;
end;
$$;

create function public.create_verification_intent(
  p_request_id uuid,
  p_lease_token uuid,
  p_epoch_id uuid,
  p_idempotency_key uuid,
  p_ttl_seconds integer default 300
) returns public.verification_intents
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.reattestation_requests;
  v_revision public.record_revisions;
  v_epoch public.protocol_epochs;
  v_intent public.verification_intents;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if p_ttl_seconds < 60 or p_ttl_seconds > 900 then raise exception using errcode = '22023', message = 'INVALID_INTENT'; end if;
  select * into v_request from public.reattestation_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'leased' or v_request.claimed_chw_id <> auth.uid() or v_request.lease_token <> p_lease_token then raise exception using errcode = '42501', message = 'LEASE_NOT_OWNER'; end if;
  if v_request.lease_expires_at <= now() then raise exception using errcode = '40001', message = 'LEASE_EXPIRED'; end if;
  select * into v_revision from public.record_revisions where id = v_request.revision_id;
  if not exists (select 1 from public.profiles p where p.user_id = v_request.user_id and p.current_revision_id = v_request.revision_id) then
    update public.reattestation_requests set status = 'superseded' where id = p_request_id;
    raise exception using errcode = '23514', message = 'INTENT_SUPERSEDED';
  end if;
  select * into v_epoch from public.protocol_epochs where id = p_epoch_id and status = 'active';
  if not found then raise exception using errcode = '23514', message = 'UNSUPPORTED_EPOCH'; end if;
  if v_epoch.schema_version <> v_revision.schema_version then raise exception using errcode = '23514', message = 'UNSUPPORTED_SCHEMA'; end if;
  update public.verification_intents set terminal_at = expires_at
    where request_id = p_request_id and terminal_at is null and expires_at <= now();
  if exists (select 1 from public.verification_intents where chw_id = auth.uid() and idempotency_key = p_idempotency_key) then
    raise exception using errcode = '23505', message = 'INTENT_REPLAYED';
  end if;
  insert into public.verification_intents(request_id, revision_id, chw_id, address_binding_id, epoch_id,
    record_commitment, schema_version, idempotency_key, expires_at)
  values(p_request_id, v_request.revision_id, auth.uid(), v_request.claimed_address_binding_id, p_epoch_id,
    v_revision.commitment, v_revision.schema_version, p_idempotency_key, now() + make_interval(secs => p_ttl_seconds))
  returning * into v_intent;
  return v_intent;
end;
$$;

create function public.mark_verification_intent_submitted(
  p_intent_id uuid,
  p_transaction_hash text
) returns public.verification_intents
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.verification_intents;
  v_chw public.chw_identities;
  v_binding public.chw_address_bindings;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if length(p_transaction_hash) not between 1 and 256 then raise exception using errcode = '22023', message = 'INVALID_INTENT'; end if;
  select * into v_intent from public.verification_intents where id = p_intent_id for update;
  if not found or v_intent.chw_id <> auth.uid() then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;
  select * into v_chw from public.chw_identities where chw_id = v_intent.chw_id;
  if v_chw.status = 'suspended' then raise exception using errcode = '42501', message = 'CHW_SUSPENDED'; end if;
  if v_chw.status <> 'active' then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;
  if v_chw.credential_expires_at is not null and v_chw.credential_expires_at <= now() then raise exception using errcode = '42501', message = 'CHW_CREDENTIAL_EXPIRED'; end if;
  select * into v_binding from public.chw_address_bindings where id = v_intent.address_binding_id;
  if v_binding.revoked_at is not null or v_binding.allowlist_synced_at is null then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;
  if v_intent.expires_at <= now() then raise exception using errcode = '40001', message = 'INTENT_EXPIRED'; end if;
  if v_intent.submitted_at is not null and v_intent.submitted_transaction_hash <> p_transaction_hash then raise exception using errcode = '23505', message = 'INTENT_REPLAYED'; end if;
  update public.verification_intents set submitted_at = coalesce(submitted_at, now()), submitted_transaction_hash = p_transaction_hash
    where id = p_intent_id returning * into v_intent;
  update public.reattestation_requests set status = 'submitted', reviewed_at = now(), review_outcome = 'approved'
    where id = v_intent.request_id and status = 'leased';
  insert into public.trust_decisions(revision_id, state, reason_code)
    values(v_intent.revision_id, 'submitted', null)
    on conflict(revision_id) do update set state = 'submitted', reason_code = null, updated_at = now();
  return v_intent;
end;
$$;

create function public.apply_finalized_attestation_evidence(
  p_event_id text,
  p_intent_id uuid,
  p_record_commitment text,
  p_attester_address text,
  p_transaction_hash text,
  p_ledger_sequence bigint,
  p_ledger_hash text,
  p_event_index integer,
  p_observed_at timestamptz,
  p_finalized_at timestamptz,
  p_network_passphrase_hash text,
  p_contract_id text,
  p_contract_version text,
  p_schema_version integer,
  p_idempotency_key uuid
) returns public.trust_decisions
language plpgsql security definer set search_path = '' as $$
declare
  v_intent public.verification_intents;
  v_epoch public.protocol_epochs;
  v_binding public.chw_address_bindings;
  v_evidence public.attestation_evidence;
  v_decision public.trust_decisions;
begin
  select * into v_intent from public.verification_intents where id = p_intent_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'INVALID_INTENT'; end if;
  select * into v_epoch from public.protocol_epochs where id = v_intent.epoch_id;
  select * into v_binding from public.chw_address_bindings where id = v_intent.address_binding_id;
  if v_intent.record_commitment <> p_record_commitment then raise exception using errcode = '23514', message = 'INTENT_REPLAYED'; end if;
  if v_binding.stellar_address <> p_attester_address then raise exception using errcode = '23514', message = 'WRONG_ADDRESS'; end if;
  if v_intent.submitted_transaction_hash is distinct from p_transaction_hash then raise exception using errcode = '23514', message = 'INTENT_REPLAYED'; end if;
  if v_epoch.network_passphrase_hash <> p_network_passphrase_hash then raise exception using errcode = '23514', message = 'WRONG_NETWORK'; end if;
  if v_epoch.contract_id <> p_contract_id or v_epoch.contract_version <> p_contract_version then raise exception using errcode = '23514', message = 'WRONG_CONTRACT'; end if;
  if v_intent.schema_version <> p_schema_version then raise exception using errcode = '23514', message = 'UNSUPPORTED_SCHEMA'; end if;
  if v_intent.idempotency_key <> p_idempotency_key then raise exception using errcode = '23514', message = 'INTENT_REPLAYED'; end if;
  if not exists (select 1 from public.profiles p where p.current_revision_id = v_intent.revision_id) then
    insert into public.trust_decisions(revision_id, state, reason_code)
      values(v_intent.revision_id, 'superseded', 'INTENT_SUPERSEDED')
      on conflict(revision_id) do update set state = 'superseded', reason_code = 'INTENT_SUPERSEDED', updated_at = now()
      returning * into v_decision;
    return v_decision;
  end if;
  if v_binding.revoked_at is not null and v_binding.revoked_at <= p_observed_at then
    insert into public.trust_decisions(revision_id, state, reason_code)
      values(v_intent.revision_id, 'revoked', 'ATTESTER_REVOKED_AT_OBSERVATION')
      on conflict(revision_id) do update set state = 'revoked', reason_code = 'ATTESTER_REVOKED_AT_OBSERVATION', updated_at = now()
      returning * into v_decision;
    return v_decision;
  end if;
  select * into v_evidence from public.attestation_evidence where intent_id = p_intent_id;
  if found then
    if v_evidence.event_id <> p_event_id or v_evidence.transaction_hash <> p_transaction_hash then
      raise exception using errcode = '23505', message = 'INTENT_REPLAYED';
    end if;
    if v_evidence.finalized_at is null and p_finalized_at is not null then
      update public.attestation_evidence set finalized_at = p_finalized_at where id = v_evidence.id
        returning * into v_evidence;
    end if;
  else
    insert into public.attestation_evidence(event_id, intent_id, transaction_hash, ledger_sequence, ledger_hash,
      event_index, observed_at, finalized_at)
    values(p_event_id, p_intent_id, p_transaction_hash, p_ledger_sequence, p_ledger_hash, p_event_index,
      p_observed_at, p_finalized_at)
    returning * into v_evidence;
  end if;
  if p_finalized_at is null then
    update public.reattestation_requests set status = 'confirming' where id = v_intent.request_id;
    insert into public.trust_decisions(revision_id, state, evidence_id, reason_code)
    values(v_intent.revision_id, 'confirming', v_evidence.id, null)
    on conflict(revision_id) do update set state = 'confirming', evidence_id = excluded.evidence_id,
      reason_code = null, updated_at = now()
    returning * into v_decision;
    return v_decision;
  end if;
  update public.verification_intents set terminal_at = coalesce(terminal_at, p_finalized_at) where id = p_intent_id;
  update public.reattestation_requests set status = 'completed' where id = v_intent.request_id;
  insert into public.trust_decisions(revision_id, state, evidence_id, reason_code, finalized_at)
  values(v_intent.revision_id, 'verified', v_evidence.id, null, p_finalized_at)
  on conflict(revision_id) do update set state = 'verified', evidence_id = excluded.evidence_id,
    reason_code = null, finalized_at = excluded.finalized_at, updated_at = now()
  returning * into v_decision;
  insert into public.payout_obligations(evidence_id, intent_id, chw_id, recipient_address, amount_usdc,
    asset_identifier, sponsor_pool, eligibility_key)
  values(v_evidence.id, v_intent.id, v_intent.chw_id, v_binding.stellar_address, v_epoch.payout_amount_usdc,
    v_epoch.asset_identifier, v_epoch.sponsor_pool,
    encode(extensions.digest(v_intent.id::text || ':' || v_evidence.id::text || ':' || v_epoch.id::text, 'sha256'), 'hex'))
  on conflict(intent_id) do nothing;
  return v_decision;
end;
$$;

create function public.reconcile_attestation_reorg(
  p_event_id text,
  p_reason_code text
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_evidence public.attestation_evidence;
begin
  select * into v_evidence from public.attestation_evidence where event_id = p_event_id for update;
  if not found then return; end if;
  update public.attestation_evidence set invalidated_at = coalesce(invalidated_at, now()), invalidation_reason = p_reason_code where id = v_evidence.id;
  update public.trust_decisions set state = 'conflicted', reason_code = p_reason_code, updated_at = now()
    where evidence_id = v_evidence.id;
  update public.payout_obligations set status = 'quarantined', adjustment_reason = p_reason_code
    where evidence_id = v_evidence.id and status = 'pending';
end;
$$;

create function public.apply_payout_settlement(
  p_transaction_hash text,
  p_recipient_address text,
  p_amount_usdc numeric,
  p_asset_identifier text,
  p_sponsor_pool text,
  p_settled_at timestamptz
) returns text
language plpgsql security definer set search_path = '' as $$
declare v_obligation public.payout_obligations; v_result text;
begin
  select * into v_obligation from public.payout_obligations
    where recipient_address = p_recipient_address and status = 'pending'
    order by created_at asc limit 1 for update;
  if not found then
    insert into public.payout_settlements(transaction_hash, recipient_address, amount_usdc, asset_identifier, sponsor_pool, settled_at, status, reason_code)
      values(p_transaction_hash, p_recipient_address, p_amount_usdc, p_asset_identifier, p_sponsor_pool, p_settled_at, 'quarantined', 'NO_PENDING_OBLIGATION')
      on conflict(transaction_hash) do nothing;
    return 'quarantined';
  end if;
  if v_obligation.amount_usdc <> p_amount_usdc or v_obligation.asset_identifier <> p_asset_identifier or v_obligation.sponsor_pool <> p_sponsor_pool then
    insert into public.payout_settlements(obligation_id, transaction_hash, recipient_address, amount_usdc, asset_identifier, sponsor_pool, settled_at, status, reason_code)
      values(v_obligation.id, p_transaction_hash, p_recipient_address, p_amount_usdc, p_asset_identifier, p_sponsor_pool, p_settled_at, 'quarantined', 'SETTLEMENT_MISMATCH')
      on conflict(transaction_hash) do nothing;
    update public.payout_obligations set status = 'quarantined', adjustment_reason = 'SETTLEMENT_MISMATCH' where id = v_obligation.id;
    return 'quarantined';
  end if;
  insert into public.payout_settlements(obligation_id, transaction_hash, recipient_address, amount_usdc, asset_identifier, sponsor_pool, settled_at, status)
    values(v_obligation.id, p_transaction_hash, p_recipient_address, p_amount_usdc, p_asset_identifier, p_sponsor_pool, p_settled_at, 'matched')
    on conflict(transaction_hash) do nothing;
  update public.payout_obligations set status = 'settled' where id = v_obligation.id;
  return 'settled';
end;
$$;

create function public.quarantine_protocol_event(
  p_stream text,
  p_event_id text,
  p_reason_code text
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_attempts integer;
begin
  if p_stream not in ('attestations', 'payments') then raise exception using errcode = '22023', message = 'INVALID_STREAM'; end if;
  insert into public.protocol_quarantine(stream, event_id, reason_code)
    values(p_stream, p_event_id, p_reason_code)
  on conflict(stream, event_id) do update set attempts = public.protocol_quarantine.attempts + 1,
    reason_code = excluded.reason_code, last_seen_at = now()
  returning attempts into v_attempts;
  return v_attempts;
end;
$$;

create view public.payout_obligation_reconciliation as
select
  date_trunc('day', created_at) as reporting_day,
  count(*) as obligations,
  count(*) filter (where status = 'settled') as settled,
  count(*) filter (where status = 'pending') as pending,
  count(*) filter (where status = 'quarantined') as quarantined,
  count(*) filter (where status = 'adjusted') as explicitly_adjusted,
  count(*) = (
    count(*) filter (where status = 'settled') + count(*) filter (where status = 'pending') +
    count(*) filter (where status = 'quarantined') + count(*) filter (where status = 'adjusted')
  ) as reconciled
from public.payout_obligations group by date_trunc('day', created_at);
revoke all on public.payout_obligation_reconciliation from anon, authenticated;
grant select on public.payout_obligation_reconciliation to service_role;

revoke all on function public.claim_verification_request(uuid, integer),
  public.renew_verification_lease(uuid, uuid, integer), public.release_verification_lease(uuid, uuid),
  public.create_verification_intent(uuid, uuid, uuid, uuid, integer),
  public.mark_verification_intent_submitted(uuid, text),
  public.apply_finalized_attestation_evidence(text, uuid, text, text, text, bigint, text, integer, timestamptz, timestamptz, text, text, text, integer, uuid),
  public.reconcile_attestation_reorg(text, text), public.apply_payout_settlement(text, text, numeric, text, text, timestamptz),
  public.quarantine_protocol_event(text, text, text)
  from public;
grant execute on function public.claim_verification_request(uuid, integer),
  public.renew_verification_lease(uuid, uuid, integer), public.release_verification_lease(uuid, uuid),
  public.create_verification_intent(uuid, uuid, uuid, uuid, integer),
  public.mark_verification_intent_submitted(uuid, text) to authenticated;
grant execute on function public.apply_finalized_attestation_evidence(text, uuid, text, text, text, bigint, text, integer, timestamptz, timestamptz, text, text, text, integer, uuid),
  public.reconcile_attestation_reorg(text, text), public.apply_payout_settlement(text, text, numeric, text, text, timestamptz),
  public.quarantine_protocol_event(text, text, text) to service_role;

-- The responder projection receives a decision state, never a bare boolean.
-- It exposes neither the evidence identifier nor the underlying commitment.
drop function public.get_emergency_card(uuid);
create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state,
  trust_updated_at timestamptz
) language sql stable security definer set search_path='' as $$
  select
    case when (p.disclosure_policy#>>'{fields,name}')::boolean then p.name end,
    case when (p.disclosure_policy#>>'{fields,age}')::boolean and p.date_of_birth is not null then extract(year from age(p.date_of_birth))::int end,
    case when (p.disclosure_policy#>>'{fields,photo_url}')::boolean then p.photo_url end,
    case when (p.disclosure_policy#>>'{fields,blood_group}')::boolean then p.blood_group end,
    case when (p.disclosure_policy#>>'{fields,genotype}')::boolean then p.genotype end,
    case when (p.disclosure_policy#>>'{fields,allergies}')::boolean then p.allergies end,
    case when (p.disclosure_policy#>>'{fields,medications}')::boolean then p.medications end,
    case when (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean then p.chronic_conditions end,
    case when (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean then p.emergency_contacts end,
    case when (p.disclosure_policy#>>'{fields,language}')::boolean then p.language end,
    (select jsonb_object_agg(k, case when (v)::boolean then 'disclosed' else 'withheld' end) from jsonb_each_text(p.disclosure_policy->'fields') f(k,v)),
    r.schema_version, public.has_active_consent(p.user_id,'offline_caching'),
    coalesce(td.state, 'unverified'::public.trust_decision_state), td.updated_at
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.card_public_id = p_card_id and r.lifecycle_state not in ('suspended','revoked','deleted')
    and public.has_active_consent(p.user_id,'emergency_public_disclosure');
$$;
revoke all on function public.get_emergency_card(uuid) from public;
grant execute on function public.get_emergency_card(uuid) to anon, authenticated;
