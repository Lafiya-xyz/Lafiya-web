-- Issue #628: detect likely duplicate patient accounts and support a
-- verified, audited merge.
--
-- Privacy: blocking keys are keyed hashes (HMAC-SHA-256 with a server-only
-- secret, computed in lib/account/duplicates.ts). Plain phone numbers, names,
-- or dates of birth are never stored here, and the keys cannot be reversed or
-- compared without the server secret. Nothing in this migration is readable
-- by anon or authenticated sessions; the app reaches it through the service
-- role only after verifying the account owner.

create table public.patient_blocking_keys (
  user_id uuid not null references auth.users(id) on delete cascade,
  key_type text not null check (key_type in ('phone', 'name_dob')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  primary key (user_id, key_type)
);
create index patient_blocking_keys_lookup_idx
  on public.patient_blocking_keys(key_type, key_hash);

-- A merge needs both accounts verified by a one-time code before any detail
-- of the other account is shown or the merge can run.
create table public.account_merge_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  other_user_id uuid references auth.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'merged', 'cancelled')),
  requester_verified_at timestamptz,
  other_verified_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint account_merge_requests_distinct check (requester_user_id <> other_user_id),
  constraint account_merge_requests_verified check (
    status not in ('verified', 'merged')
    or (requester_verified_at is not null and other_verified_at is not null)
  )
);
create index account_merge_requests_requester_idx
  on public.account_merge_requests(requester_user_id, created_at desc);

-- Survivor/loser are plain UUIDs (no FK) so the audit outlives both accounts.
create table public.account_merge_audit (
  id uuid primary key default gen_random_uuid(),
  merge_request_id uuid not null unique,
  survivor_user_id uuid not null,
  loser_user_id uuid not null,
  moved jsonb not null,
  adjusted_obligations integer not null default 0,
  merged_at timestamptz not null default now()
);

-- Delivered by the mail worker; holds no PHI, only the recipient and template.
create table public.account_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template text not null check (template in ('account_merged_survivor', 'account_merged_loser')),
  reference_id uuid not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index account_notification_outbox_unsent_idx
  on public.account_notification_outbox(created_at) where sent_at is null;

alter table public.patient_blocking_keys enable row level security;
alter table public.account_merge_requests enable row level security;
alter table public.account_merge_audit enable row level security;
alter table public.account_notification_outbox enable row level security;

revoke all on public.patient_blocking_keys, public.account_merge_requests,
  public.account_merge_audit, public.account_notification_outbox from anon, authenticated;
grant select, insert, update, delete on public.patient_blocking_keys,
  public.account_merge_requests, public.account_merge_audit,
  public.account_notification_outbox to service_role;

-- Resolves an account by email for the merge flow only (service role). The
-- caller never reveals to the requester whether an account exists.
create function public.find_user_id_by_email(p_email text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) limit 1;
$$;

-- Number of other accounts sharing a blocking key with this user.
create function public.count_duplicate_candidates(p_user_id uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(distinct other.user_id)::int
  from public.patient_blocking_keys mine
  join public.patient_blocking_keys other
    on other.key_type = mine.key_type and other.key_hash = mine.key_hash
  where mine.user_id = p_user_id and other.user_id <> p_user_id;
$$;

create function public.accounts_share_blocking_key(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.patient_blocking_keys a
    join public.patient_blocking_keys b
      on b.key_type = a.key_type and b.key_hash = a.key_hash
    where a.user_id = p_a and b.user_id = p_b
  );
$$;

-- After a merge the survivor is one patient. Only the first pending payout
-- obligation per CHW and epoch stays eligible; later duplicates are adjusted.
-- Settled obligations are never touched (they are reconciled off-chain).
create function public.recompute_patient_payout_eligibility(p_user_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_adjusted integer;
begin
  with ranked as (
    select o.id, row_number() over (
      partition by o.chw_id, i.epoch_id
      order by (o.status = 'settled') desc, o.created_at, o.id
    ) as rank, o.status
    from public.payout_obligations o
    join public.verification_intents i on i.id = o.intent_id
    join public.record_revisions r on r.id = i.revision_id
    where r.user_id = p_user_id and o.status in ('pending', 'settled')
  )
  update public.payout_obligations o
    set status = 'adjusted', adjusted_at = now(),
      adjustment_reason = 'DUPLICATE_PATIENT_MERGED'
  from ranked
  where o.id = ranked.id and ranked.rank > 1 and ranked.status = 'pending';
  get diagnostics v_adjusted = row_count;
  return v_adjusted;
end;
$$;

-- Atomic merge. Runs as one transaction: any failure rolls everything back.
create function public.merge_patient_accounts(
  p_merge_request_id uuid, p_survivor_user_id uuid
) returns public.account_merge_audit
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.account_merge_requests;
  v_loser uuid;
  v_survivor public.profiles;
  v_current public.record_revisions;
  v_next_number bigint;
  v_offset bigint;
  v_revisions integer;
  v_capabilities integer;
  v_requests integer;
  v_events integer;
  v_adjusted integer;
  v_audit public.account_merge_audit;
begin
  select * into v_request from public.account_merge_requests
    where id = p_merge_request_id for update;
  if not found or v_request.status <> 'verified' or v_request.expires_at <= now()
     or v_request.requester_verified_at is null or v_request.other_verified_at is null then
    raise exception using errcode = '42501', message = 'MERGE_NOT_VERIFIED';
  end if;
  if p_survivor_user_id = v_request.requester_user_id then
    v_loser := v_request.other_user_id;
  elsif p_survivor_user_id = v_request.other_user_id then
    v_loser := v_request.requester_user_id;
  else
    raise exception using errcode = '22023', message = 'INVALID_SURVIVOR';
  end if;
  if not public.accounts_share_blocking_key(p_survivor_user_id, v_loser) then
    raise exception using errcode = '42501', message = 'NOT_A_DUPLICATE';
  end if;

  -- Lock both profiles in a stable order to avoid deadlocks.
  perform 1 from public.profiles where user_id in (p_survivor_user_id, v_loser)
    order by user_id for update;
  select * into v_survivor from public.profiles where user_id = p_survivor_user_id;
  if not found then raise exception using errcode = 'P0002', message = 'SURVIVOR_PROFILE_NOT_FOUND'; end if;

  -- Move the loser's revision timeline after the survivor's, keeping its
  -- predecessor chain intact as a historical branch.
  select coalesce(max(revision_number), 0) into v_offset
    from public.record_revisions where user_id = p_survivor_user_id;
  update public.record_revisions set user_id = p_survivor_user_id,
    revision_number = revision_number + v_offset
    where user_id = v_loser;
  get diagnostics v_revisions = row_count;

  -- The survivor's current record continues as a new head revision numbered
  -- after both timelines, recording the merge in its provenance.
  select * into v_current from public.record_revisions where id = v_survivor.current_revision_id;
  if found then
    select max(revision_number) + 1 into v_next_number
      from public.record_revisions where user_id = p_survivor_user_id;
    insert into public.record_revisions(user_id, predecessor_id, revision_number, lifecycle_state,
      emergency_data, provenance, disclosure_policy, commitment, created_by)
    values (p_survivor_user_id, v_current.id, v_next_number, v_current.lifecycle_state,
      v_current.emergency_data,
      v_current.provenance || jsonb_build_object('merged_from_request', p_merge_request_id),
      v_current.disclosure_policy, v_current.commitment, p_survivor_user_id)
    returning * into v_current;
    -- Carry the survivor's trust decision to the new head (same commitment).
    insert into public.trust_decisions(revision_id, state, evidence_id, reason_code, finalized_at)
      select v_current.id, td.state, td.evidence_id, td.reason_code, td.finalized_at
      from public.trust_decisions td where td.revision_id = v_survivor.current_revision_id;
  end if;

  -- Re-point the loser's capabilities (kept for accountability) and revoke
  -- them, so every link printed for the loser account stops working.
  update public.emergency_capabilities set user_id = p_survivor_user_id,
    revoked_at = coalesce(revoked_at, now())
    where user_id = v_loser;
  get diagnostics v_capabilities = row_count;
  update public.card_access_events set user_id = p_survivor_user_id where user_id = v_loser;
  get diagnostics v_events = row_count;
  update public.reattestation_requests set user_id = p_survivor_user_id where user_id = v_loser;
  get diagnostics v_requests = row_count;

  -- Deleting the loser profile invalidates its legacy /card/<uuid> link.
  delete from public.profiles where user_id = v_loser;
  update public.profiles set current_revision_id = coalesce(v_current.id, current_revision_id)
    where user_id = p_survivor_user_id;
  delete from public.patient_blocking_keys where user_id = v_loser;

  v_adjusted := public.recompute_patient_payout_eligibility(p_survivor_user_id);

  update public.account_merge_requests set status = 'merged' where id = p_merge_request_id;
  insert into public.account_merge_audit(merge_request_id, survivor_user_id, loser_user_id,
    moved, adjusted_obligations)
  values (p_merge_request_id, p_survivor_user_id, v_loser,
    jsonb_build_object('revisions', v_revisions, 'capabilities_revoked', v_capabilities,
      'access_events', v_events, 'reattestation_requests', v_requests),
    v_adjusted)
  returning * into v_audit;
  insert into public.account_notification_outbox(user_id, template, reference_id) values
    (p_survivor_user_id, 'account_merged_survivor', v_audit.id),
    (v_loser, 'account_merged_loser', v_audit.id);
  return v_audit;
end;
$$;

revoke all on function public.find_user_id_by_email(text),
  public.count_duplicate_candidates(uuid), public.accounts_share_blocking_key(uuid, uuid),
  public.recompute_patient_payout_eligibility(uuid),
  public.merge_patient_accounts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.find_user_id_by_email(text),
  public.count_duplicate_candidates(uuid), public.accounts_share_blocking_key(uuid, uuid),
  public.recompute_patient_payout_eligibility(uuid),
  public.merge_patient_accounts(uuid, uuid) to service_role;
