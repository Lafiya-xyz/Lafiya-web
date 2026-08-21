-- CHW verification, trust evidence, and payout-obligation protocol (issue #172).
--
-- This migration deliberately stores identifiers, hashes, ledger references,
-- and signatures only. Patient record contents must never enter these tables.

create table public.chw_identities (
  chw_id uuid primary key references auth.users(id) on delete restrict,
  stellar_address text not null unique check (stellar_address ~ '^G[A-Z2-7]{55}$'),
  status text not null default 'pending' check (status in (
    'pending', 'active', 'suspended', 'rotating', 'recovering', 'offboarded'
  )),
  credential_expires_at timestamptz,
  proof_challenge text not null,
  proof_signature text not null,
  bound_at timestamptz,
  status_updated_at timestamptz not null default now(),
  status_updated_by uuid references auth.users(id) on delete set null,
  recovery_nonce text not null,
  created_at timestamptz not null default now(),
  check ((status = 'active') = (bound_at is not null))
);

create table public.chw_authorization_events (
  id uuid primary key default gen_random_uuid(),
  chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  event_type text not null check (event_type in (
    'enrollment_requested', 'credential_approved', 'activated', 'suspended',
    'address_rotation_requested', 'address_rotated', 'recovery_requested',
    'recovered', 'offboarded', 'break_glass_accessed'
  )),
  actor_id uuid references auth.users(id) on delete set null,
  approver_id uuid references auth.users(id) on delete set null,
  reason_code text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  check (not (metadata ?| array['patient_data', 'emergency_data']))
);

-- A registry row pins every accepted request/submission to an approved
-- network, contract, ABI schema, and finality policy. Operators must add a
-- new epoch before an upgrade; application routes must not scatter env checks.
create table public.attestation_contract_epochs (
  id uuid primary key default gen_random_uuid(),
  network_passphrase_hash text not null check (network_passphrase_hash ~ '^[0-9a-f]{64}$'),
  contract_id text not null,
  contract_version text not null,
  schema_version integer not null check (schema_version > 0),
  minimum_finality_depth integer not null check (minimum_finality_depth > 0),
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (network_passphrase_hash, contract_id, schema_version),
  check (ends_at is null or ends_at > starts_at)
);
create unique index attestation_contract_epochs_one_active_contract
  on public.attestation_contract_epochs(network_passphrase_hash, contract_id)
  where active and ends_at is null;

alter table public.reattestation_requests
  add column claimed_by uuid references public.chw_identities(chw_id) on delete set null,
  add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column released_at timestamptz,
  drop constraint reattestation_requests_status_check,
  add constraint reattestation_requests_status_check check (status in (
    'pending', 'under_review', 'submitted', 'confirming', 'completed',
    'dismissed', 'superseded'
  ));

-- Pre-protocol in-review rows did not have a lease. Return them to the queue
-- rather than manufacturing a claimant during this additive migration.
update public.reattestation_requests set status='pending'
  where status='under_review' and lease_token is null;

alter table public.reattestation_requests
  add constraint reattestation_requests_lease_consistency check (
    (status = 'under_review') = (claimed_by is not null and lease_token is not null and lease_expires_at is not null)
  );
create index reattestation_requests_claimable_idx
  on public.reattestation_requests(status, requested_at)
  where status in ('pending', 'under_review');

create table public.verification_submissions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.reattestation_requests(id) on delete restrict,
  revision_id uuid not null references public.record_revisions(id) on delete restrict,
  chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  stellar_address text not null check (stellar_address ~ '^G[A-Z2-7]{55}$'),
  contract_epoch_id uuid not null references public.attestation_contract_epochs(id) on delete restrict,
  idempotency_key uuid not null,
  intent_hash text not null check (intent_hash ~ '^[0-9a-f]{64}$'),
  intent_payload jsonb not null,
  intent_signature text not null,
  intent_expires_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  status text not null default 'submitted' check (status in ('submitted', 'confirming', 'accepted', 'rejected', 'superseded')),
  rejection_code text,
  unique (chw_id, idempotency_key),
  unique (request_id)
);

create table public.verification_trust_events (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.verification_submissions(id) on delete restrict,
  revision_id uuid not null references public.record_revisions(id) on delete restrict,
  decision text not null check (decision in (
    'unverified', 'submitted', 'confirming', 'verified', 'expired', 'revoked',
    'superseded', 'conflicted', 'unavailable'
  )),
  transaction_hash text,
  ledger_sequence bigint,
  ledger_hash text,
  event_position integer,
  observed_at timestamptz not null default now(),
  finalized_at timestamptz,
  finality_depth integer,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((decision = 'verified') = (
    transaction_hash is not null and ledger_sequence is not null and ledger_hash is not null
    and event_position is not null and finalized_at is not null and finality_depth is not null
  )),
  check (not (evidence ?| array['patient_data', 'emergency_data']))
);
create index verification_trust_events_submission_created_idx
  on public.verification_trust_events(submission_id, created_at desc, id desc);

create table public.payout_obligations (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.verification_submissions(id) on delete restrict,
  recipient_chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  recipient_stellar_address text not null check (recipient_stellar_address ~ '^G[A-Z2-7]{55}$'),
  amount numeric(20, 7) not null check (amount > 0),
  amount_version text not null,
  asset_code text not null,
  asset_issuer text not null,
  sponsor_pool_address text not null,
  status text not null default 'pending' check (status in ('pending', 'settled', 'quarantined', 'adjusted', 'reversed')),
  manual_review_reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  settlement_tx_hash text unique,
  check ((status = 'settled') = (settled_at is not null and settlement_tx_hash is not null))
);

alter table public.chw_identities enable row level security;
alter table public.chw_authorization_events enable row level security;
alter table public.attestation_contract_epochs enable row level security;
alter table public.verification_submissions enable row level security;
alter table public.verification_trust_events enable row level security;
alter table public.payout_obligations enable row level security;

create policy chw_identities_select_own on public.chw_identities
  for select to authenticated using (auth.uid() = chw_id);
create policy payout_obligations_select_own on public.payout_obligations
  for select to authenticated using (auth.uid() = recipient_chw_id);
create policy verification_submissions_select_own on public.verification_submissions
  for select to authenticated using (auth.uid() = chw_id);

revoke all on public.chw_identities, public.chw_authorization_events,
  public.attestation_contract_epochs, public.verification_submissions,
  public.verification_trust_events, public.payout_obligations from anon, authenticated;
grant select on public.chw_identities, public.verification_submissions,
  public.payout_obligations to authenticated;
grant select, insert, update, delete on public.chw_identities,
  public.chw_authorization_events, public.attestation_contract_epochs,
  public.verification_submissions, public.verification_trust_events,
  public.payout_obligations to service_role;

-- Atomically claim the oldest current request. SKIP LOCKED lets concurrent
-- workers race safely: exactly one worker receives a lease for a request.
create function public.claim_verification_request(p_chw_id uuid, p_lease_seconds integer default 600)
returns table (request_id uuid, revision_id uuid, record_hash text, lease_token uuid, lease_expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_request public.reattestation_requests; v_identity public.chw_identities;
begin
  if p_lease_seconds not between 60 and 1800 then raise exception using errcode='22023',message='INVALID_LEASE_DURATION'; end if;
  select * into v_identity from public.chw_identities
    where chw_id=p_chw_id and status='active'
      and (credential_expires_at is null or credential_expires_at > now()) for share;
  if not found then raise exception using errcode='42501',message='CHW_NOT_AUTHORIZED'; end if;
  select q.* into v_request from public.reattestation_requests q
    join public.record_revisions r on r.id=q.revision_id
    join public.profiles p on p.current_revision_id=r.id
    where (q.status='pending' or (q.status='under_review' and q.lease_expires_at <= now()))
      and q.record_hash=r.commitment and r.lifecycle_state in ('verification_requested','under_review')
      and public.has_active_consent(q.user_id, 'clinical_verification')
    order by q.requested_at, q.id limit 1 for update of q skip locked;
  if not found then return; end if;
  update public.reattestation_requests set status='under_review', claimed_by=p_chw_id,
    lease_token=gen_random_uuid(), lease_expires_at=now()+make_interval(secs=>p_lease_seconds), released_at=null
    where id=v_request.id
    returning id, public.reattestation_requests.revision_id, public.reattestation_requests.record_hash,
      public.reattestation_requests.lease_token, public.reattestation_requests.lease_expires_at
      into request_id, revision_id, record_hash, lease_token, lease_expires_at;
  update public.record_revisions set lifecycle_state='under_review' where id=revision_id;
  return next;
end;
$$;

create function public.renew_verification_lease(p_request_id uuid, p_chw_id uuid, p_lease_token uuid, p_lease_seconds integer default 600)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_expires timestamptz;
begin
  if p_lease_seconds not between 60 and 1800 then raise exception using errcode='22023',message='INVALID_LEASE_DURATION'; end if;
  update public.reattestation_requests set lease_expires_at=now()+make_interval(secs=>p_lease_seconds)
    where id=p_request_id and status='under_review' and claimed_by=p_chw_id and lease_token=p_lease_token
      and lease_expires_at > now() returning lease_expires_at into v_expires;
  if not found then raise exception using errcode='42501',message='LEASE_NOT_ACTIVE'; end if;
  return v_expires;
end;
$$;

create function public.release_verification_lease(p_request_id uuid, p_chw_id uuid, p_lease_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.reattestation_requests set status='pending', claimed_by=null, lease_token=null,
    lease_expires_at=null, released_at=now()
    where id=p_request_id and status='under_review' and claimed_by=p_chw_id and lease_token=p_lease_token;
  if not found then raise exception using errcode='42501',message='LEASE_NOT_ACTIVE'; end if;
end;
$$;

-- The verifier calls this after wallet-specific signature verification. It
-- verifies all application bindings again in the database transaction.
create function public.record_verification_submission(
  p_request_id uuid, p_chw_id uuid, p_lease_token uuid, p_contract_epoch_id uuid,
  p_idempotency_key uuid, p_intent_hash text, p_intent_payload jsonb,
  p_intent_signature text, p_intent_expires_at timestamptz
) returns public.verification_submissions
language plpgsql security definer set search_path = '' as $$
declare v_request public.reattestation_requests; v_identity public.chw_identities;
  v_epoch public.attestation_contract_epochs; v_submission public.verification_submissions;
begin
  if p_intent_hash !~ '^[0-9a-f]{64}$' or p_intent_expires_at <= now() then
    raise exception using errcode='22023',message='INVALID_OR_EXPIRED_INTENT';
  end if;
  select * into v_request from public.reattestation_requests where id=p_request_id for update;
  if not found then raise exception using errcode='P0002',message='REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'under_review' or v_request.claimed_by <> p_chw_id
    or v_request.lease_token <> p_lease_token or v_request.lease_expires_at <= now() then
    raise exception using errcode='42501',message='LEASE_NOT_ACTIVE';
  end if;
  if not public.has_active_consent(v_request.user_id, 'clinical_verification') then
    raise exception using errcode='42501',message='CONSENT_REQUIRED';
  end if;
  select * into v_identity from public.chw_identities where chw_id=p_chw_id and status='active'
    and (credential_expires_at is null or credential_expires_at > now());
  if not found then raise exception using errcode='42501',message='CHW_NOT_AUTHORIZED'; end if;
  select * into v_epoch from public.attestation_contract_epochs where id=p_contract_epoch_id
    and active and starts_at <= now() and (ends_at is null or ends_at > now());
  if not found then raise exception using errcode='22023',message='UNSUPPORTED_CONTRACT_EPOCH'; end if;
  if exists(select 1 from public.verification_submissions where request_id=p_request_id) then
    raise exception using errcode='23505',message='REQUEST_ALREADY_SUBMITTED';
  end if;
  if (p_intent_payload->>'requestId') is distinct from p_request_id::text
    or (p_intent_payload->>'revisionId') is distinct from v_request.revision_id::text
    or (p_intent_payload->>'recordHash') is distinct from v_request.record_hash
    or (p_intent_payload->>'chwId') is distinct from p_chw_id::text
    or (p_intent_payload->>'stellarAddress') is distinct from v_identity.stellar_address
    or (p_intent_payload->>'contractId') is distinct from v_epoch.contract_id
    or (p_intent_payload->>'networkPassphraseHash') is distinct from v_epoch.network_passphrase_hash
    or (p_intent_payload->>'schemaVersion') is distinct from v_epoch.schema_version::text then
    raise exception using errcode='22023',message='INTENT_BINDING_MISMATCH';
  end if;
  insert into public.verification_submissions(request_id,revision_id,chw_id,stellar_address,contract_epoch_id,
    idempotency_key,intent_hash,intent_payload,intent_signature,intent_expires_at)
    values(p_request_id,v_request.revision_id,p_chw_id,v_identity.stellar_address,p_contract_epoch_id,
      p_idempotency_key,p_intent_hash,p_intent_payload,p_intent_signature,p_intent_expires_at)
    returning * into v_submission;
  update public.reattestation_requests set status='submitted', lease_token=null, lease_expires_at=null where id=p_request_id;
  insert into public.verification_trust_events(submission_id,revision_id,decision)
    values(v_submission.id,v_submission.revision_id,'submitted');
  return v_submission;
end;
$$;

create function public.finalize_verification_trust(
  p_submission_id uuid, p_decision text, p_transaction_hash text, p_ledger_sequence bigint,
  p_ledger_hash text, p_event_position integer, p_finality_depth integer, p_finalized_at timestamptz,
  p_evidence jsonb, p_amount numeric, p_amount_version text, p_asset_code text,
  p_asset_issuer text, p_sponsor_pool_address text
) returns public.verification_trust_events
language plpgsql security definer set search_path = '' as $$
declare v_submission public.verification_submissions; v_epoch public.attestation_contract_epochs;
  v_event public.verification_trust_events;
begin
  select * into v_submission from public.verification_submissions where id=p_submission_id for update;
  if not found then raise exception using errcode='P0002',message='SUBMISSION_NOT_FOUND'; end if;
  select * into v_epoch from public.attestation_contract_epochs where id=v_submission.contract_epoch_id;
  if p_decision='verified' and (p_finality_depth < v_epoch.minimum_finality_depth
    or p_finalized_at is null or p_transaction_hash is null or p_ledger_sequence is null
    or p_ledger_hash is null or p_event_position is null) then
    raise exception using errcode='22023',message='INSUFFICIENT_FINALITY_EVIDENCE';
  end if;
  if p_decision='verified' and not exists(
    select 1 from public.profiles where current_revision_id=v_submission.revision_id
  ) then p_decision := 'superseded'; end if;
  insert into public.verification_trust_events(submission_id,revision_id,decision,transaction_hash,
    ledger_sequence,ledger_hash,event_position,finalized_at,finality_depth,evidence)
    values(p_submission_id,v_submission.revision_id,p_decision,p_transaction_hash,p_ledger_sequence,
      p_ledger_hash,p_event_position,p_finalized_at,p_finality_depth,coalesce(p_evidence,'{}')) returning * into v_event;
  if p_decision='verified' then
    insert into public.payout_obligations(submission_id,recipient_chw_id,recipient_stellar_address,amount,
      amount_version,asset_code,asset_issuer,sponsor_pool_address)
      values(v_submission.id,v_submission.chw_id,v_submission.stellar_address,p_amount,p_amount_version,
        p_asset_code,p_asset_issuer,p_sponsor_pool_address) on conflict(submission_id) do nothing;
    update public.verification_submissions set status='accepted' where id=p_submission_id;
    update public.reattestation_requests set status='completed' where id=v_submission.request_id;
    update public.record_revisions set lifecycle_state='verified' where id=v_submission.revision_id;
  elsif p_decision in ('conflicted','unavailable') then
    update public.verification_submissions set status='confirming' where id=p_submission_id;
    update public.reattestation_requests set status='confirming' where id=v_submission.request_id;
  end if;
  return v_event;
end;
$$;

revoke all on function public.claim_verification_request(uuid,integer),
  public.renew_verification_lease(uuid,uuid,uuid,integer),
  public.release_verification_lease(uuid,uuid,uuid),
  public.record_verification_submission(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,timestamptz),
  public.finalize_verification_trust(uuid,text,text,bigint,text,integer,integer,timestamptz,jsonb,numeric,text,text,text,text) from public;
grant execute on function public.claim_verification_request(uuid,integer),
  public.renew_verification_lease(uuid,uuid,uuid,integer),
  public.release_verification_lease(uuid,uuid,uuid),
  public.record_verification_submission(uuid,uuid,uuid,uuid,uuid,text,jsonb,text,timestamptz),
  public.finalize_verification_trust(uuid,text,text,bigint,text,integer,integer,timestamptz,jsonb,numeric,text,text,text,text) to service_role;
