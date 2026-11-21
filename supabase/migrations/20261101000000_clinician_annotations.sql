-- Issue #919: provenance-tracked clinician annotations on a patient card.
--
-- A verified clinician (an active, non-expired public.chw_identities row, the
-- same bar break-glass access uses) may attach an annotation to a patient's
-- current record revision. Annotations are private until the patient approves
-- them; only approved annotations are ever projected onto the public card or
-- into the record canonicalization input.

create type public.clinician_annotation_state as enum (
  'pending', 'approved', 'rejected', 'withdrawn'
);

create table public.clinician_annotations (
  id uuid primary key default gen_random_uuid(),
  patient_user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null references public.record_revisions(id) on delete restrict,
  clinician_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  organization text not null check (char_length(organization) between 1 and 200),
  body text not null check (char_length(body) between 1 and 2000),
  -- Optional structured code (e.g. SNOMED/ICD-10): {system, code, display}.
  code jsonb,
  state public.clinician_annotation_state not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint clinician_annotation_code_shape check (
    code is null or (
      jsonb_typeof(code) = 'object'
      and jsonb_typeof(code->'system') = 'string'
      and jsonb_typeof(code->'code') = 'string'
    )
  ),
  constraint clinician_annotation_decision check (
    (state = 'pending' and decided_at is null)
    or (state <> 'pending' and decided_at is not null)
  )
);

comment on table public.clinician_annotations is
  'Clinician-authored annotations (issue #919). PHI: body/code are clinical text. Only state = approved rows are ever disclosed publicly.';

create index clinician_annotations_patient_idx
  on public.clinician_annotations(patient_user_id, created_at desc);
create index clinician_annotations_revision_idx
  on public.clinician_annotations(revision_id) where state = 'approved';
create index clinician_annotations_clinician_idx
  on public.clinician_annotations(clinician_id, created_at desc);

alter table public.clinician_annotations enable row level security;

-- The patient sees every annotation on their own record (the approval inbox).
create policy clinician_annotations_select_patient on public.clinician_annotations
  for select to authenticated using (auth.uid() = patient_user_id);
-- The authoring clinician sees their own annotations.
create policy clinician_annotations_select_clinician on public.clinician_annotations
  for select to authenticated using (auth.uid() = clinician_id);

revoke all on public.clinician_annotations from anon, authenticated;
grant select on public.clinician_annotations to authenticated;
grant select, insert, update, delete on public.clinician_annotations to service_role;

-- Clinician submission. Identity, organization and timestamp are taken from
-- the server-side session/registry, never from client input.
create or replace function public.create_clinician_annotation(
  p_patient_user_id uuid, p_body text, p_organization text, p_code jsonb default null
) returns public.clinician_annotations
language plpgsql security definer set search_path = '' as $$
declare v_identity public.chw_identities; v_revision uuid; v_row public.clinician_annotations;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  select * into v_identity from public.chw_identities where chw_id = auth.uid();
  if not found or v_identity.status <> 'active'
     or (v_identity.credential_expires_at is not null and v_identity.credential_expires_at <= now()) then
    raise exception using errcode = '42501', message = 'CLINICIAN_NOT_VERIFIED';
  end if;
  select current_revision_id into v_revision from public.profiles where user_id = p_patient_user_id;
  if v_revision is null then
    raise exception using errcode = 'P0002', message = 'RECORD_NOT_FOUND';
  end if;
  insert into public.clinician_annotations
    (patient_user_id, revision_id, clinician_id, organization, body, code)
  values (p_patient_user_id, v_revision, auth.uid(), p_organization, p_body, p_code)
  returning * into v_row;
  return v_row;
end;
$$;

-- Patient decision on an annotation. Only the patient may approve/reject.
create or replace function public.decide_clinician_annotation(
  p_annotation_id uuid, p_approve boolean
) returns public.clinician_annotations
language plpgsql security definer set search_path = '' as $$
declare v_row public.clinician_annotations;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'AUTH_REQUIRED';
  end if;
  update public.clinician_annotations
    set state = case when p_approve then 'approved'::public.clinician_annotation_state
                     else 'rejected'::public.clinician_annotation_state end,
        decided_at = now()
    where id = p_annotation_id and patient_user_id = auth.uid() and state = 'pending'
    returning * into v_row;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'ANNOTATION_NOT_FOUND';
  end if;
  return v_row;
end;
$$;

-- Public projection: approved annotations only, with provenance. Used by the
-- card RPCs and by the canonicalization input.
create or replace function public.approved_clinician_annotations(p_revision_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'author', a.clinician_id,
    'organization', a.organization,
    'createdAt', a.created_at,
    'approvedAt', a.decided_at,
    'body', a.body,
    'code', a.code
  ) order by a.created_at, a.id), '[]'::jsonb)
  from public.clinician_annotations a
  where a.revision_id = p_revision_id and a.state = 'approved';
$$;

revoke all on function public.create_clinician_annotation(uuid, text, text, jsonb),
  public.decide_clinician_annotation(uuid, boolean),
  public.approved_clinician_annotations(uuid) from public;
grant execute on function public.create_clinician_annotation(uuid, text, text, jsonb),
  public.decide_clinician_annotation(uuid, boolean) to authenticated;
grant execute on function public.approved_clinician_annotations(uuid) to anon, authenticated, service_role;

-- Card projections gain a trailing `clinician_annotations` column carrying
-- approved annotations only (provenance included). Unapproved rows never
-- leave the database through these functions.
drop function public.get_emergency_card(uuid);
create function public.get_emergency_card(p_card_id uuid)
returns table (
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state, trust_updated_at timestamptz,
  record_updated_at timestamptz, authorization_expires_at timestamptz,
  clinician_annotations jsonb
)
language sql stable security definer set search_path = ''
as $$
  select
    case when (p.disclosure_policy#>>'{fields,name}')::boolean
      then p.name end,
    case when (p.disclosure_policy#>>'{fields,age}')::boolean
              and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when (p.disclosure_policy#>>'{fields,photo_url}')::boolean
      then p.photo_url end,
    case when (p.disclosure_policy#>>'{fields,blood_group}')::boolean
      then p.blood_group end,
    case when (p.disclosure_policy#>>'{fields,genotype}')::boolean
      then p.genotype end,
    case when (p.disclosure_policy#>>'{fields,allergies}')::boolean
      then p.allergies end,
    case when (p.disclosure_policy#>>'{fields,medications}')::boolean
      then p.medications end,
    case when (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean
      then p.chronic_conditions end,
    case when (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean
      then p.emergency_contacts end,
    case when (p.disclosure_policy#>>'{fields,language}')::boolean
      then p.language end,
    (select jsonb_object_agg(k, case when (v)::boolean then 'disclosed' else 'withheld' end)
       from jsonb_each_text(p.disclosure_policy->'fields') f(k, v)),
    r.schema_version,
    public.has_active_consent(p.user_id, 'offline_caching'),
    coalesce(td.state, 'unverified'::public.trust_decision_state),
    td.updated_at,
    p.updated_at,
    p.legacy_card_sunset_at,
    public.approved_clinician_annotations(r.id)
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.card_public_id = p_card_id
    and p.legacy_card_sunset_at > now()
    and r.lifecycle_state not in ('suspended', 'revoked', 'deleted')
    and public.has_active_consent(p.user_id, 'emergency_public_disclosure');
$$;

revoke all on function public.get_emergency_card(uuid) from public;
grant execute on function public.get_emergency_card(uuid) to anon, authenticated;

create or replace function public.consume_emergency_capability(p_token_digest text)
returns table (
  access_state text,
  capability_id uuid,
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  disclosure_states jsonb, schema_version integer, offline_cache_allowed boolean,
  trust_state public.trust_decision_state, trust_updated_at timestamptz,
  record_updated_at timestamptz, authorization_expires_at timestamptz,
  clinician_annotations jsonb
)
language plpgsql security definer set search_path = '' as $$
declare v_capability public.emergency_capabilities;
begin
  if p_token_digest !~ '^[0-9a-f]{64}$' then
    return query select 'not_found'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  select * into v_capability from public.emergency_capabilities
    where token_digest = p_token_digest for update;

  if not found then
    return query select 'not_found'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  if v_capability.revoked_at is not null then
    return query select 'revoked'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  if v_capability.expires_at <= now() then
    return query select 'expired'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  if v_capability.max_views is not null and v_capability.used_views >= v_capability.max_views then
    return query select 'exhausted'::text, null::uuid,
      null::text, null::int, null::text, null::public.blood_group_enum,
      null::public.genotype_enum, null::text[], null::text[], null::text[], null::jsonb,
      null::text, null::jsonb, null::int, false, null::public.trust_decision_state,
      null::timestamptz, null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  update public.emergency_capabilities
    set used_views = used_views + 1, last_resolved_at = now()
    where id = v_capability.id;

  insert into public.card_access_events (user_id, capability_id, access_kind, outcome)
  values (v_capability.user_id, v_capability.id, 'capability', 'served');

  return query
  select 'active'::text, v_capability.id,
    case when (p.disclosure_policy#>>'{fields,name}')::boolean
              and (v_capability.field_allowlist#>>'{fields,name}')::boolean
      then p.name end,
    case when (p.disclosure_policy#>>'{fields,age}')::boolean
              and (v_capability.field_allowlist#>>'{fields,age}')::boolean
              and p.date_of_birth is not null
      then extract(year from age(p.date_of_birth))::int end,
    case when (p.disclosure_policy#>>'{fields,photo_url}')::boolean
              and (v_capability.field_allowlist#>>'{fields,photo_url}')::boolean
      then p.photo_url end,
    case when (p.disclosure_policy#>>'{fields,blood_group}')::boolean
              and (v_capability.field_allowlist#>>'{fields,blood_group}')::boolean
      then p.blood_group end,
    case when (p.disclosure_policy#>>'{fields,genotype}')::boolean
              and (v_capability.field_allowlist#>>'{fields,genotype}')::boolean
      then p.genotype end,
    case when (p.disclosure_policy#>>'{fields,allergies}')::boolean
              and (v_capability.field_allowlist#>>'{fields,allergies}')::boolean
      then p.allergies end,
    case when (p.disclosure_policy#>>'{fields,medications}')::boolean
              and (v_capability.field_allowlist#>>'{fields,medications}')::boolean
      then p.medications end,
    case when (p.disclosure_policy#>>'{fields,chronic_conditions}')::boolean
              and (v_capability.field_allowlist#>>'{fields,chronic_conditions}')::boolean
      then p.chronic_conditions end,
    case when (p.disclosure_policy#>>'{fields,emergency_contacts}')::boolean
              and (v_capability.field_allowlist#>>'{fields,emergency_contacts}')::boolean
      then p.emergency_contacts end,
    case when (p.disclosure_policy#>>'{fields,language}')::boolean
              and (v_capability.field_allowlist#>>'{fields,language}')::boolean
      then p.language end,
    (select jsonb_object_agg(k, case when (v)::boolean then 'disclosed' else 'withheld' end)
       from jsonb_each_text(p.disclosure_policy->'fields') f(k, v)),
    r.schema_version,
    public.has_active_consent(p.user_id, 'offline_caching'),
    coalesce(td.state, 'unverified'::public.trust_decision_state),
    td.updated_at,
    p.updated_at,
    v_capability.expires_at,
    public.approved_clinician_annotations(r.id)
  from public.profiles p
  join public.record_revisions r on r.id = p.current_revision_id
  left join public.trust_decisions td on td.revision_id = r.id
  where p.user_id = v_capability.user_id
    and r.lifecycle_state not in ('suspended', 'revoked', 'deleted')
    and public.has_active_consent(p.user_id, 'emergency_public_disclosure');
end;
$$;

revoke all on function public.consume_emergency_capability(text) from public;
grant execute on function public.consume_emergency_capability(text) to anon, authenticated;
