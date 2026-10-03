-- Issue #543: break-glass access for verified clinicians.
--
-- Adds a `clinician_only` disclosure tier: fields a patient withholds from
-- the public/capability card but is willing to expose to a verified
-- clinician who declares an emergency and accepts a heavy audit trail plus
-- an immediate, post-hoc patient notification.
--
-- Clinician identity is reused from the existing CHW identity binding
-- (public.chw_identities), matching option 2 in the issue's proposed
-- approach. A dedicated verified-clinician registry (and the ADR the issue
-- asks for) is a separate, larger follow-up — this migration only gates on
-- an active, non-expired CHW identity, the same bar already used for
-- reattestation review leases.

alter table public.profiles
  add column clinician_disclosure_policy jsonb not null default
    '{"version":1,"fields":{"name":false,"age":false,"photo_url":false,"blood_group":false,"genotype":false,"allergies":false,"medications":false,"chronic_conditions":false,"emergency_contacts":false,"language":false}}'::jsonb;

comment on column public.profiles.clinician_disclosure_policy is
  'Fields the patient marked clinician-only: never rendered on the public/capability card, only ever disclosed through a break-glass access.';

-- Immutable audit trail. Rows are never updated or deleted by application
-- roles; patient_notified_at is the one field the service role fills in
-- once the post-hoc notification has actually been sent.
create table public.break_glass_accesses (
  id uuid primary key default gen_random_uuid(),
  patient_user_id uuid not null references auth.users(id) on delete cascade,
  clinician_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  revision_id uuid not null references public.record_revisions(id),
  reason text not null check (char_length(reason) between 1 and 500),
  fields_disclosed jsonb not null,
  opened_at timestamptz not null default now(),
  expires_at timestamptz not null,
  patient_notified_at timestamptz,
  constraint break_glass_access_expiry check (expires_at > opened_at)
);
create index break_glass_accesses_patient_idx
  on public.break_glass_accesses(patient_user_id, opened_at desc);
create index break_glass_accesses_clinician_idx
  on public.break_glass_accesses(clinician_id, opened_at desc);
create index break_glass_accesses_unnotified_idx
  on public.break_glass_accesses(opened_at) where patient_notified_at is null;

alter table public.break_glass_accesses enable row level security;

create policy break_glass_accesses_select_patient on public.break_glass_accesses
  for select to authenticated using (auth.uid() = patient_user_id);
create policy break_glass_accesses_select_clinician on public.break_glass_accesses
  for select to authenticated using (auth.uid() = clinician_id);

revoke all on public.break_glass_accesses from anon, authenticated;
grant select on public.break_glass_accesses to authenticated;
grant select, insert, update, delete on public.break_glass_accesses to service_role;

-- Patient-facing: choose which fields are clinician-only. Mirrors
-- update_disclosure_policy's optimistic-concurrency shape and
-- create_emergency_capability's allowlist validation.
create or replace function public.update_clinician_disclosure_policy(
  p_expected_revision_id uuid, p_clinician_disclosure_policy jsonb
) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare v_profile public.profiles;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  if jsonb_typeof(p_clinician_disclosure_policy->'fields') <> 'object'
    or exists (
      select 1 from jsonb_each(p_clinician_disclosure_policy->'fields') f(key, value)
      where key not in ('name', 'age', 'photo_url', 'blood_group', 'genotype', 'allergies',
                        'medications', 'chronic_conditions', 'emergency_contacts', 'language')
         or jsonb_typeof(value) <> 'boolean'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_CLINICIAN_FIELD_ALLOWLIST';
  end if;

  select * into v_profile from public.profiles where user_id = auth.uid() for update;
  if not found or v_profile.current_revision_id is distinct from p_expected_revision_id then
    raise exception using errcode = '40001', message = 'STALE_REVISION',
      detail = coalesce(v_profile.current_revision_id::text, 'none');
  end if;

  update public.profiles set clinician_disclosure_policy = p_clinician_disclosure_policy
    where user_id = auth.uid() returning * into v_profile;
  return v_profile;
end;
$$;
revoke all on function public.update_clinician_disclosure_policy(uuid, jsonb) from public;
grant execute on function public.update_clinician_disclosure_policy(uuid, jsonb) to authenticated;

-- Clinician-facing break-glass open. Verifies the caller is an active,
-- non-expired CHW identity, writes the audit row first (so an access is
-- always recorded even if nothing is ultimately rendered), and returns only
-- the clinician-only fields the patient has opted to expose this way.
-- patient_notified_at is intentionally left null here: notification happens
-- after this call returns, and the caller marks it sent separately.
create or replace function public.open_break_glass_access(
  p_patient_user_id uuid, p_reason text
) returns table (
  access_id uuid,
  expires_at timestamptz,
  name text, age int, photo_url text, blood_group public.blood_group_enum,
  genotype public.genotype_enum, allergies text[], medications text[],
  chronic_conditions text[], emergency_contacts jsonb, language text,
  fields_disclosed jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_chw public.chw_identities;
  v_profile public.profiles;
  v_revision public.record_revisions;
  v_reason text;
  v_fields jsonb;
  v_access public.break_glass_accesses;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED';
  end if;

  select * into v_chw from public.chw_identities where chw_id = auth.uid();
  if not found or v_chw.status <> 'active' then
    raise exception using errcode = '42501', message = 'CLINICIAN_NOT_VERIFIED';
  end if;
  if v_chw.credential_expires_at is not null and v_chw.credential_expires_at <= now() then
    raise exception using errcode = '42501', message = 'CLINICIAN_CREDENTIAL_EXPIRED';
  end if;

  select * into v_profile from public.profiles where user_id = p_patient_user_id;
  if not found or v_profile.current_revision_id is null then
    raise exception using errcode = 'P0002', message = 'PATIENT_NOT_FOUND';
  end if;
  select * into v_revision from public.record_revisions where id = v_profile.current_revision_id;
  if not found or v_revision.lifecycle_state in ('suspended', 'revoked', 'deleted') then
    raise exception using errcode = 'P0002', message = 'PATIENT_NOT_FOUND';
  end if;

  select jsonb_object_agg(k, (v)::boolean) into v_fields
    from jsonb_each_text(v_profile.clinician_disclosure_policy->'fields') f(k, v)
    where (v)::boolean;
  v_fields := coalesce(v_fields, '{}'::jsonb);

  -- The audit row is written unconditionally, before any data is returned,
  -- so a break-glass event is always recorded even for a patient with no
  -- clinician-only fields configured.
  insert into public.break_glass_accesses(
    patient_user_id, clinician_id, revision_id, reason, fields_disclosed, expires_at
  ) values (
    p_patient_user_id, auth.uid(), v_revision.id, v_reason, v_fields, now() + interval '10 minutes'
  ) returning * into v_access;

  return query
  select v_access.id, v_access.expires_at,
    case when coalesce((v_fields->>'name')::boolean, false) then v_profile.name end,
    case when coalesce((v_fields->>'age')::boolean, false) and v_profile.date_of_birth is not null
      then extract(year from age(v_profile.date_of_birth))::int end,
    case when coalesce((v_fields->>'photo_url')::boolean, false) then v_profile.photo_url end,
    case when coalesce((v_fields->>'blood_group')::boolean, false) then v_profile.blood_group end,
    case when coalesce((v_fields->>'genotype')::boolean, false) then v_profile.genotype end,
    case when coalesce((v_fields->>'allergies')::boolean, false) then v_profile.allergies end,
    case when coalesce((v_fields->>'medications')::boolean, false) then v_profile.medications end,
    case when coalesce((v_fields->>'chronic_conditions')::boolean, false) then v_profile.chronic_conditions end,
    case when coalesce((v_fields->>'emergency_contacts')::boolean, false) then v_profile.emergency_contacts end,
    case when coalesce((v_fields->>'language')::boolean, false) then v_profile.language end,
    v_fields;
end;
$$;
revoke all on function public.open_break_glass_access(uuid, text) from public;
grant execute on function public.open_break_glass_access(uuid, text) to authenticated;

-- Service-role only: flips the post-hoc notification marker once the
-- notification has actually been sent (see lib/emergency/break-glass.ts).
create or replace function public.mark_break_glass_patient_notified(p_access_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.break_glass_accesses set patient_notified_at = coalesce(patient_notified_at, now())
    where id = p_access_id;
  if not found then raise exception using errcode = 'P0002', message = 'ACCESS_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.mark_break_glass_patient_notified(uuid) from public;
grant execute on function public.mark_break_glass_patient_notified(uuid) to service_role;

comment on function public.open_break_glass_access(uuid, text) is
  'Break-glass read for a verified clinician. Always writes an audit row before returning data; patient notification happens out-of-band after this call.';
comment on table public.break_glass_accesses is
  'Immutable audit trail for break-glass clinician access to clinician-only fields (issue #543). patient_notified_at is set post-hoc once notification is sent.';
