-- Transactional outbox for side effects (issue #624).
--
-- Side effects triggered by writes (cache invalidation, notifications, future
-- webhooks) are recorded in this table inside the SAME transaction as the
-- write.  A background dispatcher consumes rows with FOR UPDATE SKIP LOCKED,
-- calls idempotent handlers, and marks rows dispatched_at.  This guarantees:
--   • No effect is lost for a committed write.
--   • No effect is emitted for a rolled-back write.
--   • Redelivery is safe because all handlers are idempotent.
--
-- save_record_revision() is extended below to insert an outbox row whenever
-- it commits a new revision, replacing the direct attestation-cache call.

-- ──────────────────────────────────────────────────────────────────────────
-- Outbox table
-- ──────────────────────────────────────────────────────────────────────────

create table public.outbox (
  id            uuid        primary key default gen_random_uuid(),
  aggregate     text        not null,          -- e.g. 'record_revision'
  event_type    text        not null,          -- e.g. 'record_saved'
  payload       jsonb       not null default '{}',
  created_at    timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts      integer     not null default 0 check (attempts >= 0)
);

-- Fast dispatcher poll: pending rows first, oldest first.
create index outbox_pending_idx
  on public.outbox(created_at)
  where dispatched_at is null;

comment on table public.outbox is
  'Transactional outbox (issue #624). Rows are written inside application '
  'transactions and consumed asynchronously by the dispatcher. Handlers must '
  'be idempotent; redelivery is guaranteed on dispatcher restart.';

comment on column public.outbox.aggregate is
  'Logical aggregate that produced the event (record_revision, profile, etc.).';

comment on column public.outbox.event_type is
  'Domain event name within the aggregate (record_saved, card_regenerated, etc.).';

comment on column public.outbox.payload is
  'Event-specific data. PHI and capability tokens must NEVER appear here. '
  'Use opaque identifiers (commitment hashes, revision IDs) only.';

-- ──────────────────────────────────────────────────────────────────────────
-- RLS: service role dispatches; authenticated users have no direct access.
-- ──────────────────────────────────────────────────────────────────────────

alter table public.outbox enable row level security;

grant select, insert, update, delete on public.outbox to service_role;
-- authenticated role gets no grant: outbox is internal infrastructure.

-- ──────────────────────────────────────────────────────────────────────────
-- Extend save_record_revision to write an outbox row atomically.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.save_record_revision(
  p_expected_revision_id uuid,
  p_emergency_data       jsonb,
  p_provenance           jsonb,
  p_disclosure_policy    jsonb,
  p_commitment           text
) returns public.record_revisions
language plpgsql security definer set search_path = '' as $$
declare
  v_profile  public.profiles;
  v_previous public.record_revisions;
  v_revision public.record_revisions;
  v_state    public.record_lifecycle_state;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  if p_commitment !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_COMMITMENT';
  end if;

  select * into v_profile from public.profiles where user_id = auth.uid() for update;
  if found then
    if v_profile.current_revision_id is distinct from p_expected_revision_id then
      raise exception using errcode = '40001', message = 'STALE_REVISION',
        detail = coalesce(v_profile.current_revision_id::text, 'none');
    end if;
    select * into v_previous
      from public.record_revisions where id = v_profile.current_revision_id;
    v_state := case
      when v_previous.lifecycle_state = 'verified'
        then 'stale_after_edit'::public.record_lifecycle_state
      else 'shareable'::public.record_lifecycle_state
    end;
  elsif p_expected_revision_id is not null then
    raise exception using errcode = '40001', message = 'STALE_REVISION', detail = 'none';
  else
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
    select * into v_profile from public.profiles where user_id = auth.uid() for update;
    if found then
      raise exception using errcode = '40001', message = 'STALE_REVISION',
        detail = v_profile.current_revision_id::text;
    end if;
    v_state := 'shareable';
  end if;

  insert into public.record_revisions(
    user_id, predecessor_id, revision_number, lifecycle_state,
    emergency_data, provenance, disclosure_policy, commitment, created_by
  ) values (
    auth.uid(),
    v_profile.current_revision_id,
    coalesce(v_previous.revision_number, 0) + 1,
    v_state,
    p_emergency_data,
    p_provenance,
    p_disclosure_policy,
    p_commitment,
    auth.uid()
  ) returning * into v_revision;

  insert into public.profiles(
    user_id, name, date_of_birth, photo_url, language,
    blood_group, genotype, allergies, medications, chronic_conditions,
    emergency_contacts, disclosure_policy, current_revision_id
  ) values (
    auth.uid(),
    p_emergency_data->>'name',
    nullif(p_emergency_data->>'date_of_birth', '')::date,
    nullif(p_emergency_data->>'photo_url', ''),
    nullif(p_emergency_data->>'language', ''),
    (p_emergency_data->>'blood_group')::public.blood_group_enum,
    (p_emergency_data->>'genotype')::public.genotype_enum,
    array(select jsonb_array_elements_text(p_emergency_data->'allergies')),
    array(select jsonb_array_elements_text(p_emergency_data->'medications')),
    array(select jsonb_array_elements_text(p_emergency_data->'chronic_conditions')),
    p_emergency_data->'emergency_contacts',
    p_disclosure_policy,
    v_revision.id
  ) on conflict(user_id) do update set
    name               = excluded.name,
    date_of_birth      = excluded.date_of_birth,
    photo_url          = excluded.photo_url,
    language           = excluded.language,
    blood_group        = excluded.blood_group,
    genotype           = excluded.genotype,
    allergies          = excluded.allergies,
    medications        = excluded.medications,
    chronic_conditions = excluded.chronic_conditions,
    emergency_contacts = excluded.emergency_contacts,
    disclosure_policy  = excluded.disclosure_policy,
    current_revision_id = excluded.current_revision_id;

  update public.reattestation_requests
    set status = 'superseded'
    where user_id = auth.uid()
      and status in ('pending', 'under_review')
      and revision_id is distinct from v_revision.id;

  -- ── Outbox: write side-effect intent atomically with the revision ────────
  -- The dispatcher (lib/outbox/dispatcher.ts) will pick this up and call
  -- invalidateAttestationCache(commitment) so the cache invalidation is never
  -- lost and never fires for a rolled-back write.
  -- Only the opaque commitment hash is stored — no PHI, no capability tokens.
  insert into public.outbox(aggregate, event_type, payload)
  values (
    'record_revision',
    'record_saved',
    jsonb_build_object(
      'revision_id',  v_revision.id,
      'commitment',   p_commitment,
      'user_id_hash', encode(digest(auth.uid()::text, 'sha256'), 'hex')
    )
  );
  -- ────────────────────────────────────────────────────────────────────────

  return v_revision;
end;
$$;

revoke all on function public.save_record_revision(uuid, jsonb, jsonb, jsonb, text) from public;
grant execute on function public.save_record_revision(uuid, jsonb, jsonb, jsonb, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- Dispatcher helper: claim a batch of pending rows atomically.
-- Called by lib/outbox/dispatcher.ts via the service-role client.
-- Returns at most `p_batch_size` rows that are now locked for this worker.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.claim_outbox_batch(p_batch_size integer default 50)
returns setof public.outbox
language sql security definer set search_path = '' as $$
  update public.outbox
    set attempts = attempts + 1
  where id in (
    select id from public.outbox
    where dispatched_at is null
    order by created_at
    limit p_batch_size
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_outbox_batch(integer) from public;
grant execute on function public.claim_outbox_batch(integer) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Mark a row dispatched (idempotent on duplicate calls).
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.ack_outbox_row(p_id uuid)
returns void
language sql security definer set search_path = '' as $$
  update public.outbox
    set dispatched_at = now()
  where id = p_id and dispatched_at is null;
$$;

revoke all on function public.ack_outbox_row(uuid) from public;
grant execute on function public.ack_outbox_row(uuid) to service_role;
