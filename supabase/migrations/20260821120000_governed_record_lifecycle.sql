-- Governed, immutable patient-record lifecycle (issue #173).
--
-- profiles remains the compatibility/current snapshot. All committed writes
-- go through save_record_revision(), which locks the profile row, checks the
-- caller's expected revision, inserts an immutable revision, updates the
-- snapshot and supersedes obsolete verification work in one transaction.

create type public.record_lifecycle_state as enum (
  'draft', 'shareable', 'verification_requested', 'under_review', 'verified',
  'stale_after_edit', 'suspended', 'revoked', 'deleted'
);

create type public.data_provenance as enum (
  'absent', 'unknown', 'patient_reported', 'clinician_verified'
);

alter table public.profiles
  add column current_revision_id uuid,
  add column disclosure_policy jsonb not null default '{"version":1,"fields":{"name":true,"age":true,"photo_url":true,"blood_group":true,"genotype":true,"allergies":true,"medications":true,"chronic_conditions":true,"emergency_contacts":true,"language":true}}'::jsonb;

-- A first governed save must create-if-absent the HMAC secret before it can
-- compute the revision commitment. Bind the secret to the auth identity,
-- not to a profile row that does not exist until that same save transaction.
alter table public.profile_secrets drop constraint profile_secrets_user_id_fkey;
alter table public.profile_secrets add constraint profile_secrets_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

create table public.record_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  predecessor_id uuid references public.record_revisions(id),
  schema_version integer not null default 1 check (schema_version = 1),
  revision_number bigint not null check (revision_number > 0),
  lifecycle_state public.record_lifecycle_state not null,
  emergency_data jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  disclosure_policy jsonb not null,
  commitment text not null check (commitment ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint record_revisions_user_number_key unique (user_id, revision_number)
);

alter table public.profiles
  add constraint profiles_current_revision_fk
  foreign key (current_revision_id) references public.record_revisions(id)
  on delete set null;

create unique index record_revisions_one_successor
  on public.record_revisions(predecessor_id) where predecessor_id is not null;
create index record_revisions_user_created_idx
  on public.record_revisions(user_id, created_at desc);

alter table public.reattestation_requests
  add column revision_id uuid references public.record_revisions(id),
  drop constraint reattestation_requests_status_check,
  add constraint reattestation_requests_status_check check
    (status in ('pending','under_review','completed','dismissed','superseded'));

drop index public.reattestation_requests_pending_unique;
create unique index reattestation_requests_active_revision_unique
  on public.reattestation_requests(revision_id)
  where status in ('pending','under_review');

create table public.consent_purposes (
  purpose text not null,
  version integer not null check (version > 0),
  required boolean not null,
  description text not null,
  active boolean not null default true,
  primary key (purpose, version),
  constraint consent_purpose_name check (purpose in (
    'account_processing', 'emergency_public_disclosure', 'offline_caching',
    'clinical_verification', 'optional_analytics'
  ))
);

insert into public.consent_purposes(purpose, version, required, description) values
  ('account_processing', 1, true, 'Process data required to provide the Lafiya account.'),
  ('emergency_public_disclosure', 1, false, 'Disclose selected emergency fields to holders of the card link.'),
  ('offline_caching', 1, false, 'Permit selected emergency fields to be cached on responder devices.'),
  ('clinical_verification', 1, false, 'Permit an authorized health worker to review the selected revision.'),
  ('optional_analytics', 1, false, 'Permit optional, non-clinical product analytics.');

create table public.consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null,
  purpose_version integer not null,
  action text not null check (action in ('acknowledged','withdrawn')),
  occurred_at timestamptz not null default now(),
  idempotency_key uuid not null,
  foreign key (purpose, purpose_version)
    references public.consent_purposes(purpose, version),
  unique (user_id, idempotency_key)
);
create index consent_events_current_idx
  on public.consent_events(user_id, purpose, occurred_at desc, id desc);

-- Existing signup consent is preserved as account-processing history.
insert into public.consent_events
  (user_id, purpose, purpose_version, action, occurred_at, idempotency_key)
select user_id, 'account_processing', 1, 'acknowledged', accepted_at, id
from public.consent_logs on conflict do nothing;

-- Do not infer optional disclosure or offline-caching consent from a legacy
-- account-creation acknowledgement. Existing cards remain withheld until the
-- account holder explicitly opts into the versioned purpose below.

-- Backfill exactly one initial immutable revision. last_attested_hash is the
-- existing commitment when available. For never-attested rows, a random
-- opaque commitment is used and repaired on the first application save; it
-- is not published or treated as verified.
insert into public.record_revisions (
  id, user_id, predecessor_id, revision_number, lifecycle_state,
  emergency_data, provenance, disclosure_policy, commitment, created_by,
  created_at
)
select
  gen_random_uuid(), p.user_id, null, 1,
  case when p.last_attested_hash is not null then 'verified'::public.record_lifecycle_state
       else 'shareable'::public.record_lifecycle_state end,
  jsonb_build_object(
    'name', p.name, 'date_of_birth', p.date_of_birth,
    'photo_url', p.photo_url, 'language', p.language,
    'blood_group', p.blood_group, 'genotype', p.genotype,
    'allergies', p.allergies, 'medications', p.medications,
    'chronic_conditions', p.chronic_conditions,
    'emergency_contacts', p.emergency_contacts
  ),
  '{}'::jsonb, p.disclosure_policy,
  coalesce(p.last_attested_hash, encode(gen_random_bytes(32), 'hex')),
  p.user_id, p.created_at
from public.profiles p
where not exists (
  select 1 from public.record_revisions r where r.user_id = p.user_id
);

update public.profiles p set current_revision_id = r.id
from public.record_revisions r
where r.user_id = p.user_id and r.revision_number = 1
  and p.current_revision_id is null;

alter table public.record_revisions enable row level security;
alter table public.consent_purposes enable row level security;
alter table public.consent_events enable row level security;

create policy record_revisions_select_own on public.record_revisions
  for select to authenticated using (auth.uid() = user_id);
create policy consent_purposes_read on public.consent_purposes
  for select to authenticated using (active);
create policy consent_events_select_own on public.consent_events
  for select to authenticated using (auth.uid() = user_id);

grant select on public.record_revisions, public.consent_purposes,
  public.consent_events to authenticated;
grant select, insert, update, delete on public.record_revisions,
  public.consent_purposes, public.consent_events to service_role;

create or replace function public.has_active_consent(p_user_id uuid, p_purpose text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select ce.action = 'acknowledged'
    from public.consent_events ce
    where ce.user_id = p_user_id and ce.purpose = p_purpose
    order by ce.occurred_at desc, ce.id desc limit 1
  ), false);
$$;
revoke all on function public.has_active_consent(uuid, text) from public;
grant execute on function public.has_active_consent(uuid, text)
  to authenticated, service_role;

-- Issue #509: consent_events is the single source of truth. All application
-- writes must go through record_consent(); all reads through
-- has_active_consent() or the consent_ledger compatibility view below.
create or replace function public.record_consent(
  p_user_id uuid,
  p_purpose text,
  p_purpose_version integer,
  p_action text,
  p_idempotency_key uuid
) returns public.consent_events
language plpgsql security definer set search_path = '' as $$
declare
  v_event public.consent_events;
begin
  if p_action not in ('acknowledged','withdrawn') then
    raise exception 'invalid consent action: %', p_action;
  end if;

  insert into public.consent_events
    (user_id, purpose, purpose_version, action, idempotency_key)
  values (p_user_id, p_purpose, p_purpose_version, p_action, p_idempotency_key)
  on conflict (user_id, idempotency_key) do nothing
  returning * into v_event;

  if v_event.id is null then
    select * into v_event from public.consent_events
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
  end if;

  return v_event;
end;
$$;
revoke all on function public.record_consent(uuid, text, integer, text, uuid)
  from public;
grant execute on function public.record_consent(uuid, text, integer, text, uuid)
  to authenticated, service_role;

-- Read-only compatibility view so legacy readers see the unified ledger.
create or replace view public.consent_ledger
  with (security_invoker = true) as
select
  ce.id,
  ce.user_id,
  ce.purpose,
  ce.purpose_version,
  ce.action,
  ce.occurred_at,
  ce.idempotency_key
from public.consent_events ce;

grant select on public.consent_ledger to authenticated, service_role;

-- Replace consent_logs with a read-only compatibility view for one release.
-- The underlying table is renamed so no application code can write to it
-- directly; a follow-up migration drops the renamed table.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'consent_logs'
      and table_type = 'BASE TABLE'
  ) then
    alter table public.consent_logs rename to consent_logs_legacy;
  end if;
end;
$$;

create or replace view public.consent_logs
  with (security_invoker = true) as
select
  ce.id,
  ce.user_id,
  ce.occurred_at as accepted_at,
  ce.purpose as policy_version
from public.consent_events ce
where ce.purpose = 'account_processing' and ce.action = 'acknowledged';

grant select on public.consent_logs to authenticated, service_role;
revoke insert, update, delete on public.consent_logs from authenticated, service_role;

-- Idempotent backfill verification: row-count and checksum assertions.
do $$
declare
  v_legacy_count bigint;
  v_event_count bigint;
  v_legacy_checksum text;
  v_event_checksum text;
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'consent_logs_legacy'
      and table_type = 'BASE TABLE'
  ) then
    execute 'select count(*), coalesce(md5(string_agg(user_id::text || accepted_at::text, '','' order by user_id, accepted_at)), '''') from public.consent_logs_legacy'
      into v_legacy_count, v_legacy_checksum;

    select count(*), coalesce(md5(string_agg(user_id::text || occurred_at::text, '','' order by user_id, occurred_at)), '')
      into v_event_count, v_event_checksum
    from public.consent_events
    where purpose = 'account_processing' and action = 'acknowledged';

    if v_event_count < v_legacy_count then
      raise exception 'consent backfill row-count mismatch: legacy=% events=%',
        v_legacy_count, v_event_count;
    end if;

    if v_legacy_checksum <> v_event_checksum then
      raise exception 'consent backfill checksum mismatch: legacy=% events=%',
        v_legacy_checksum, v_event_checksum;
    end if;
  end if;
end;
$$;
