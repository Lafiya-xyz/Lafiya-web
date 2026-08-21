-- Epic #174: bounded emergency-access capabilities and privacy-safe access
-- accountability. Raw capabilities are never persisted: only their SHA-256
-- digest is stored and resolved. Legacy UUID cards remain available during a
-- deliberately finite migration window so existing printed cards do not fail
-- at deploy time.

create type public.emergency_capability_purpose as enum ('emergency', 'temporary');

alter table public.profiles
  add column legacy_card_sunset_at timestamptz not null
    default (now() + interval '180 days');

comment on column public.profiles.legacy_card_sunset_at is
  'End of the compatibility window for the legacy UUID bearer URL. Patients must rotate to a bounded capability before this time.';

create table public.emergency_capabilities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  purpose public.emergency_capability_purpose not null,
  field_allowlist jsonb not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  max_views integer check (max_views is null or (max_views between 1 and 20)),
  used_views integer not null default 0 check (used_views >= 0),
  revoked_at timestamptz,
  rotated_from_id uuid references public.emergency_capabilities(id) on delete set null,
  replaced_by_id uuid references public.emergency_capabilities(id) on delete set null,
  last_resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint emergency_capability_expiry check (expires_at > issued_at),
  constraint emergency_capability_purpose_budget check (
    (purpose = 'emergency' and max_views is null)
    or (purpose = 'temporary' and max_views is not null)
  ),
  constraint emergency_capability_rotation_not_self check (
    rotated_from_id is null or rotated_from_id <> id
  ),
  constraint emergency_capability_replacement_not_self check (
    replaced_by_id is null or replaced_by_id <> id
  )
);
create index emergency_capabilities_owner_idx
  on public.emergency_capabilities(user_id, created_at desc);
create index emergency_capabilities_expiry_idx
  on public.emergency_capabilities(expires_at) where revoked_at is null;

-- This is intentionally an aggregate-friendly, non-identifying event. It
-- contains no capability, IP, user agent, record/revision ID, or health data.
create table public.card_access_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capability_id uuid references public.emergency_capabilities(id) on delete set null,
  access_kind text not null check (access_kind in ('legacy', 'capability')),
  outcome text not null check (outcome in ('served', 'inactive')),
  observed_at timestamptz not null default now()
);
create index card_access_events_owner_time_idx
  on public.card_access_events(user_id, observed_at desc);

alter table public.emergency_capabilities enable row level security;
alter table public.card_access_events enable row level security;

create policy emergency_capabilities_select_own on public.emergency_capabilities
  for select to authenticated using (auth.uid() = user_id);
create policy card_access_events_select_own on public.card_access_events
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.emergency_capabilities, public.card_access_events from anon, authenticated;
grant select on public.emergency_capabilities, public.card_access_events to authenticated;
grant select, insert, update, delete on public.emergency_capabilities, public.card_access_events to service_role;

-- Patient-facing issuance. The application obtains entropy from node:crypto,
-- hashes it locally, and sends only the digest across this RPC boundary.
create function public.create_emergency_capability(
  p_token_digest text,
  p_purpose public.emergency_capability_purpose,
  p_field_allowlist jsonb,
  p_expires_at timestamptz,
  p_max_views integer default null
) returns public.emergency_capabilities
language plpgsql security definer set search_path = '' as $$
declare v_capability public.emergency_capabilities;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'INVALID_CAPABILITY_DIGEST';
  end if;
  if jsonb_typeof(p_field_allowlist) <> 'object'
    or exists (
      select 1 from jsonb_each(p_field_allowlist) f(key, value)
      where key not in ('name', 'age', 'photo_url', 'blood_group', 'genotype', 'allergies',
                        'medications', 'chronic_conditions', 'emergency_contacts', 'language')
         or jsonb_typeof(value) <> 'boolean'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_FIELD_ALLOWLIST';
  end if;
  if p_expires_at <= now() then
    raise exception using errcode = '22023', message = 'CAPABILITY_ALREADY_EXPIRED';
  end if;
  if p_purpose = 'emergency' and (p_max_views is not null or p_expires_at > now() + interval '180 days') then
    raise exception using errcode = '22023', message = 'INVALID_EMERGENCY_CAPABILITY_POLICY';
  end if;
  if p_purpose = 'temporary' and (p_max_views is null or p_expires_at > now() + interval '30 days') then
    raise exception using errcode = '22023', message = 'INVALID_TEMPORARY_CAPABILITY_POLICY';
  end if;

  insert into public.emergency_capabilities(
    user_id, token_digest, purpose, field_allowlist, expires_at, max_views
  ) values (
    auth.uid(), p_token_digest, p_purpose, p_field_allowlist, p_expires_at, p_max_views
  ) returning * into v_capability;
  return v_capability;
end;
$$;

create function public.revoke_emergency_capability(p_capability_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  update public.emergency_capabilities set revoked_at = coalesce(revoked_at, now())
    where id = p_capability_id and user_id = auth.uid();
  if not found then raise exception using errcode = 'P0002', message = 'CAPABILITY_NOT_FOUND'; end if;
end;
$$;

-- Resolving a capability performs the view-budget transition in the same row
-- lock as authorization. This makes retries/races deterministic: at most the
-- configured number of successful resolutions can return protected data.
create function public.consume_emergency_capability(p_token_digest text)
returns table (
  access_state text,
  capability_id uuid,
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state, trust_updated_at timestamptz,
  record_updated_at timestamptz, authorization_expires_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
declare v_capability public.emergency_capabilities;
begin
  -- A malformed/unknown/inactive capability all follows the same database
  -- lookup and returns the same no-data response to minimize oracle value.
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    return query select 'inactive'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;
  select * into v_capability from public.emergency_capabilities
    where token_digest = p_token_digest for update;
  if not found or v_capability.revoked_at is not null
     or v_capability.expires_at <= now()
     or (v_capability.max_views is not null and v_capability.used_views >= v_capability.max_views) then
    return query select 'inactive'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  update public.emergency_capabilities set used_views = used_views + 1,
    last_resolved_at = now() where id = v_capability.id;

  return query
  select 'active'::text, v_capability.id,
    case when coalesce((v_capability.field_allowlist->>'name')::boolean, false)
              and (p.disclosure_policy#>>'{fields,name}')::boolean then p.name end,
    case when coalesce((v_capability.field_allowlist->>'age')::boolean, false)
              and (p.disclosure_policy#>>'{fields,age}')::boolean and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when coalesce((v_capability.field_allowlist->>'photo_url')::boolean, false)
              and (p.disclosure_policy#>>'{fields,photo_url}')::boolean then p.photo_url end,
    case when coalesce((v_capability.field_allowlist->>'blood_group')::boolean, false)
              and (p.disclosure_policy#>>'{fields,blood_group}')::boolean then p.blood_group end,
    case when coalesce((v_capability.field_allowlist->>'genotype')::boolean, false)
              and (p.disclosure_policy#>>'{fields,genotype}')::boolean then p.genotype end,
    case when coalesce((v_capability.field_allowlist->>'allergies')::boolean, false)
              and (p.disclosure_policy#>>'{fields,allergies}')::boolean then p.allergies end,
    case when coalesce((v_capability.field_allowlist->>'medications')::boolean, false)
              and (p.disclosure_policy#>>'{fields,medications}')::boolean then p.medications end,
    case when coalesce((v_capability.field_allowlist->>'chronic_conditions')::boolean, false)
              and (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean then p.chronic_conditions end,
    case when coalesce((v_capability.field_allowlist->>'emergency_contacts')::boolean, false)
              and (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean then p.emergency_contacts end,
    case when coalesce((v_capability.field_allowlist->>'language')::boolean, false)
              and (p.disclosure_policy#>>'{fields,language}')::boolean then p.language end,
    (select jsonb_object_agg(k, case when coalesce((v_capability.field_allowlist->>k)::boolean, false)
      and (v)::boolean then 'disclosed' else 'withheld' end)
      from jsonb_each_text(p.disclosure_policy->'fields') f(k,v)),
    r.schema_version, public.has_active_consent(p.user_id, 'offline_caching'),
    coalesce(td.state, 'unverified'::public.trust_decision_state), td.updated_at,
    r.created_at, v_capability.expires_at
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.user_id = v_capability.user_id
    and r.lifecycle_state not in ('suspended','revoked','deleted')
    and public.has_active_consent(p.user_id, 'emergency_public_disclosure');

  -- Consent withdrawal and lifecycle changes also fail closed. Do not reveal
  -- which condition made the capability unavailable.
  if not found then
    return query select 'inactive'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

-- Deferred, service-role-only event write. Retention is enforced here so a
-- missed external cron cannot make this privacy-sensitive table permanent.
create function public.record_card_access_event(
  p_capability_id uuid, p_access_kind text, p_outcome text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid;
begin
  if p_access_kind not in ('legacy', 'capability') or p_outcome not in ('served', 'inactive') then
    raise exception using errcode = '22023', message = 'INVALID_ACCESS_EVENT';
  end if;
  select user_id into v_user_id from public.emergency_capabilities where id = p_capability_id;
  if not found then raise exception using errcode = 'P0002', message = 'CAPABILITY_NOT_FOUND'; end if;
  delete from public.card_access_events where observed_at < now() - interval '90 days';
  insert into public.card_access_events(user_id, capability_id, access_kind, outcome)
    values(v_user_id, p_capability_id, p_access_kind, p_outcome);
end;
$$;

create function public.record_legacy_card_access_event(p_card_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid;
begin
  select user_id into v_user_id from public.profiles
    where card_public_id = p_card_id and legacy_card_sunset_at > now();
  if not found then return; end if;
  delete from public.card_access_events where observed_at < now() - interval '90 days';
  insert into public.card_access_events(user_id, capability_id, access_kind, outcome)
    values(v_user_id, null, 'legacy', 'served');
end;
$$;

create function public.get_my_card_access_summary()
returns table (views_last_30_days bigint, last_viewed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select count(*) filter (where outcome = 'served' and observed_at >= now() - interval '30 days'),
    max(observed_at) filter (where outcome = 'served')
  from public.card_access_events where user_id = auth.uid();
$$;

-- UUID URLs remain a compatibility path only. Their end date is enforced in
-- the same public projection function rather than relying on a UI reminder.
drop function public.get_emergency_card(uuid);
create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state, trust_updated_at timestamptz,
  record_updated_at timestamptz, authorization_expires_at timestamptz
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
    coalesce(td.state, 'unverified'::public.trust_decision_state), td.updated_at,
    r.created_at, p.legacy_card_sunset_at
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.card_public_id = p_card_id and p.legacy_card_sunset_at > now()
    and r.lifecycle_state not in ('suspended','revoked','deleted')
    and public.has_active_consent(p.user_id,'emergency_public_disclosure');
$$;

revoke all on function public.create_emergency_capability(text, public.emergency_capability_purpose, jsonb, timestamptz, integer),
  public.revoke_emergency_capability(uuid), public.consume_emergency_capability(text),
  public.record_card_access_event(uuid, text, text), public.record_legacy_card_access_event(uuid), public.get_my_card_access_summary(),
  public.get_emergency_card(uuid) from public;
grant execute on function public.create_emergency_capability(text, public.emergency_capability_purpose, jsonb, timestamptz, integer),
  public.revoke_emergency_capability(uuid), public.get_my_card_access_summary() to authenticated;
grant execute on function public.consume_emergency_capability(text), public.get_emergency_card(uuid) to anon, authenticated;
grant execute on function public.record_card_access_event(uuid, text, text) to service_role;
grant execute on function public.record_legacy_card_access_event(uuid) to service_role;

comment on function public.consume_emergency_capability(text) is
  'Atomic capability authorization and view-budget consumption. Raw capability is hashed before this call and never stored.';
comment on function public.record_card_access_event(uuid, text, text) is
  'Retained for 90 days; stores only owner, capability surrogate, coarse outcome, and time. No IP, user agent, capability, record identifiers, or health data.';
