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
revoke all on function public.has_active_consent(uuid,text) from public;
grant execute on function public.has_active_consent(uuid,text) to service_role;

create or replace function public.record_consent(
  p_purpose text, p_purpose_version integer, p_action text,
  p_idempotency_key uuid
) returns public.consent_events
language plpgsql security definer set search_path = '' as $$
declare v_event public.consent_events;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='AUTH_REQUIRED'; end if;
  insert into public.consent_events(user_id,purpose,purpose_version,action,idempotency_key)
  values(auth.uid(),p_purpose,p_purpose_version,p_action,p_idempotency_key)
  on conflict(user_id,idempotency_key) do update set idempotency_key=excluded.idempotency_key
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function public.record_consent(text,integer,text,uuid) from public;
grant execute on function public.record_consent(text,integer,text,uuid) to authenticated;

create or replace function public.save_record_revision(
  p_expected_revision_id uuid,
  p_emergency_data jsonb,
  p_provenance jsonb,
  p_disclosure_policy jsonb,
  p_commitment text
) returns public.record_revisions
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_previous public.record_revisions;
  v_revision public.record_revisions;
  v_state public.record_lifecycle_state;
begin
  if auth.uid() is null then raise exception using errcode='42501', message='AUTH_REQUIRED'; end if;
  if p_commitment !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023', message='INVALID_COMMITMENT';
  end if;

  select * into v_profile from public.profiles where user_id=auth.uid() for update;
  if found then
    if v_profile.current_revision_id is distinct from p_expected_revision_id then
      raise exception using errcode='40001', message='STALE_REVISION',
        detail=coalesce(v_profile.current_revision_id::text, 'none');
    end if;
    select * into v_previous from public.record_revisions where id=v_profile.current_revision_id;
    v_state := case when v_previous.lifecycle_state='verified' then 'stale_after_edit'::public.record_lifecycle_state
                    else 'shareable'::public.record_lifecycle_state end;
  elsif p_expected_revision_id is not null then
    raise exception using errcode='40001', message='STALE_REVISION', detail='none';
  else
    -- Serialize competing first saves for the same auth identity.
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 0));
    select * into v_profile from public.profiles where user_id=auth.uid() for update;
    if found then raise exception using errcode='40001', message='STALE_REVISION', detail=v_profile.current_revision_id::text; end if;
    v_state := 'shareable';
  end if;

  insert into public.record_revisions(
    user_id, predecessor_id, revision_number, lifecycle_state, emergency_data,
    provenance, disclosure_policy, commitment, created_by
  ) values (
    auth.uid(), v_profile.current_revision_id, coalesce(v_previous.revision_number,0)+1,
    v_state, p_emergency_data, p_provenance, p_disclosure_policy,
    p_commitment, auth.uid()
  ) returning * into v_revision;

  insert into public.profiles(
    user_id,name,date_of_birth,photo_url,language,blood_group,genotype,
    allergies,medications,chronic_conditions,emergency_contacts,
    disclosure_policy,current_revision_id
  ) values (
    auth.uid(), p_emergency_data->>'name', nullif(p_emergency_data->>'date_of_birth','')::date,
    nullif(p_emergency_data->>'photo_url',''), nullif(p_emergency_data->>'language',''),
    (p_emergency_data->>'blood_group')::public.blood_group_enum,
    (p_emergency_data->>'genotype')::public.genotype_enum,
    array(select jsonb_array_elements_text(p_emergency_data->'allergies')),
    array(select jsonb_array_elements_text(p_emergency_data->'medications')),
    array(select jsonb_array_elements_text(p_emergency_data->'chronic_conditions')),
    p_emergency_data->'emergency_contacts', p_disclosure_policy, v_revision.id
  ) on conflict(user_id) do update set
    name=excluded.name,date_of_birth=excluded.date_of_birth,photo_url=excluded.photo_url,
    language=excluded.language,blood_group=excluded.blood_group,genotype=excluded.genotype,
    allergies=excluded.allergies,medications=excluded.medications,
    chronic_conditions=excluded.chronic_conditions,
    emergency_contacts=excluded.emergency_contacts,
    disclosure_policy=excluded.disclosure_policy,current_revision_id=excluded.current_revision_id;

  update public.reattestation_requests set status='superseded'
    where user_id=auth.uid() and status in ('pending','under_review')
      and revision_id is distinct from v_revision.id;
  return v_revision;
end;
$$;
revoke all on function public.save_record_revision(uuid,jsonb,jsonb,jsonb,text) from public;
grant execute on function public.save_record_revision(uuid,jsonb,jsonb,jsonb,text) to authenticated;

create or replace function public.update_disclosure_policy(
  p_expected_revision_id uuid, p_disclosure_policy jsonb
) returns public.record_revisions
language plpgsql security definer set search_path='' as $$
declare v_profile public.profiles; v_previous public.record_revisions; v_revision public.record_revisions;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='AUTH_REQUIRED'; end if;
  select * into v_profile from public.profiles where user_id=auth.uid() for update;
  if not found or v_profile.current_revision_id is distinct from p_expected_revision_id then
    raise exception using errcode='40001',message='STALE_REVISION',detail=coalesce(v_profile.current_revision_id::text,'none');
  end if;
  select * into v_previous from public.record_revisions where id=v_profile.current_revision_id;
  insert into public.record_revisions(user_id,predecessor_id,revision_number,lifecycle_state,
    emergency_data,provenance,disclosure_policy,commitment,created_by)
  values(auth.uid(),v_previous.id,v_previous.revision_number+1,v_previous.lifecycle_state,
    v_previous.emergency_data,v_previous.provenance,p_disclosure_policy,v_previous.commitment,auth.uid())
  returning * into v_revision;
  update public.profiles set disclosure_policy=p_disclosure_policy,current_revision_id=v_revision.id
    where user_id=auth.uid();
  return v_revision;
end;
$$;
revoke all on function public.update_disclosure_policy(uuid,jsonb) from public;
grant execute on function public.update_disclosure_policy(uuid,jsonb) to authenticated;

-- Compatibility guard for older clients/seed scripts during the expand
-- window. A direct profile INSERT receives one unverified initial revision;
-- subsequent edits still must use save_record_revision (UPDATE is blocked
-- below). This trigger skips the new RPC, which supplies its own pointer.
create function public.initialize_profile_revision()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if new.current_revision_id is not null then return new; end if;
  insert into public.record_revisions(user_id,revision_number,lifecycle_state,
    emergency_data,provenance,disclosure_policy,commitment,created_by)
  values(new.user_id,1,'shareable',jsonb_build_object(
    'name',new.name,'date_of_birth',new.date_of_birth,'photo_url',new.photo_url,
    'language',new.language,'blood_group',new.blood_group,'genotype',new.genotype,
    'allergies',new.allergies,'medications',new.medications,
    'chronic_conditions',new.chronic_conditions,'emergency_contacts',new.emergency_contacts
  ),'{}',new.disclosure_policy,pg_catalog.encode(extensions.gen_random_bytes(32),'hex'),new.user_id)
  returning id into v_id;
  update public.profiles set current_revision_id=v_id where user_id=new.user_id;
  return new;
end;
$$;
create trigger profiles_initialize_revision after insert on public.profiles
for each row execute function public.initialize_profile_revision();

create function public.request_revision_verification(p_expected_revision_id uuid)
returns public.reattestation_requests
language plpgsql security definer set search_path='' as $$
declare v_profile public.profiles; v_previous public.record_revisions; v_revision public.record_revisions; v_request public.reattestation_requests;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='AUTH_REQUIRED'; end if;
  if not public.has_active_consent(auth.uid(),'clinical_verification') then raise exception using errcode='42501',message='CONSENT_REQUIRED'; end if;
  select * into v_profile from public.profiles where user_id=auth.uid() for update;
  if not found or v_profile.current_revision_id is distinct from p_expected_revision_id then raise exception using errcode='40001',message='STALE_REVISION'; end if;
  select * into v_previous from public.record_revisions where id=v_profile.current_revision_id;
  if v_previous.lifecycle_state not in ('shareable','stale_after_edit') then raise exception using errcode='23514',message='INVALID_LIFECYCLE_TRANSITION'; end if;
  insert into public.record_revisions(user_id,predecessor_id,revision_number,lifecycle_state,emergency_data,provenance,disclosure_policy,commitment,created_by)
  values(auth.uid(),v_previous.id,v_previous.revision_number+1,'verification_requested',v_previous.emergency_data,v_previous.provenance,v_previous.disclosure_policy,v_previous.commitment,auth.uid()) returning * into v_revision;
  update public.profiles set current_revision_id=v_revision.id where user_id=auth.uid();
  update public.reattestation_requests set status='superseded' where user_id=auth.uid() and status in ('pending','under_review');
  insert into public.reattestation_requests(user_id,record_hash,revision_id) values(auth.uid(),v_revision.commitment,v_revision.id) returning * into v_request;
  return v_request;
end;
$$;
revoke all on function public.request_revision_verification(uuid) from public;
grant execute on function public.request_revision_verification(uuid) to authenticated;

-- Explicit disclosure projection. Consent withdrawal makes the old card URL
-- immediately return no rows. Withheld fields return state only, never value.
drop function public.get_emergency_card(uuid);
create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, revision_id uuid, schema_version integer,
  commitment text, offline_cache_allowed boolean
) language sql stable security definer set search_path='' as $$
  select
    case when (p.disclosure_policy#>>'{fields,name}')::boolean then p.name end,
    case when (p.disclosure_policy#>>'{fields,age}')::boolean and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when (p.disclosure_policy#>>'{fields,photo_url}')::boolean then p.photo_url end,
    case when (p.disclosure_policy#>>'{fields,blood_group}')::boolean then p.blood_group end,
    case when (p.disclosure_policy#>>'{fields,genotype}')::boolean then p.genotype end,
    case when (p.disclosure_policy#>>'{fields,allergies}')::boolean then p.allergies end,
    case when (p.disclosure_policy#>>'{fields,medications}')::boolean then p.medications end,
    case when (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean then p.chronic_conditions end,
    case when (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean then p.emergency_contacts end,
    case when (p.disclosure_policy#>>'{fields,language}')::boolean then p.language end,
    (select jsonb_object_agg(k, case when (v)::boolean then 'disclosed' else 'withheld' end)
       from jsonb_each_text(p.disclosure_policy->'fields') f(k,v)),
    r.id, r.schema_version, r.commitment,
    public.has_active_consent(p.user_id,'offline_caching')
  from public.profiles p join public.record_revisions r on r.id=p.current_revision_id
  where p.card_public_id=p_card_id
    and r.lifecycle_state not in ('suspended','revoked','deleted')
    and public.has_active_consent(p.user_id,'emergency_public_disclosure');
$$;
revoke all on function public.get_emergency_card(uuid) from public;
grant execute on function public.get_emergency_card(uuid) to anon,authenticated;

comment on function public.get_emergency_card(uuid) is
  'Versioned, consent-gated, field-allowlisted emergency-card projection. Never SELECTs arbitrary profile columns.';

-- Reconciliation: exactly one current pointer and no cross-owner predecessor.
create view public.record_revision_reconciliation as
select p.user_id, p.current_revision_id,
  count(r.id) filter(where r.id=p.current_revision_id) as current_matches,
  count(r.id) as revision_count
from public.profiles p left join public.record_revisions r on r.user_id=p.user_id
group by p.user_id,p.current_revision_id;
revoke all on public.record_revision_reconciliation from anon,authenticated;
grant select on public.record_revision_reconciliation to service_role;
