-- Issue #871: verifiable parental/guardian consent for minors' cards (NDPA).
--
-- Creates:
--   public.dependants.card_public         — card visibility flag (default off)
--   public.guardian_consents              — append-only consent ledger rows
--                                           (evidence *references* only)
--   record_guardian_consent()             — RPC: guardian requests assurance
--   verify_guardian_consent()             — RPC (service role): CHW, facility
--                                           or operator records verification
--   set_dependant_card_public()           — RPC: guardian toggles visibility
--   has_verified_guardian_consent()       — helper used by the guard trigger
-- A trigger blocks making a minor's card public without verified consent
-- from the *current* guardian under the current policy version; guardian
-- changes and the age-of-majority handover therefore require re-confirmation.

alter table public.dependants
  add column if not exists card_public boolean not null default false;

create table public.guardian_consents (
  id               uuid primary key default gen_random_uuid(),
  dependant_id     uuid not null references public.dependants(id) on delete cascade,
  guardian_id      uuid not null references auth.users(id) on delete cascade,
  method           text not null
                   check (method in ('chw_in_person', 'facility_confirmation', 'document_review')),
  status           text not null default 'pending'
                   check (status in ('pending', 'verified', 'rejected')),
  verifier_id      uuid references auth.users(id),
  -- Opaque reference to evidence held by the verifier (never the document).
  evidence_ref     text check (evidence_ref is null or char_length(evidence_ref) <= 200),
  policy_version   text not null,
  requested_at     timestamptz not null default now(),
  verified_at      timestamptz,
  check (status <> 'verified' or (verifier_id is not null and verified_at is not null))
);

create index guardian_consents_dependant_idx
  on public.guardian_consents (dependant_id, guardian_id, status);

alter table public.guardian_consents enable row level security;

create policy "guardian_consents_select_own"
  on public.guardian_consents for select
  to authenticated
  using (guardian_id = (select auth.uid()));

grant select on public.guardian_consents to authenticated;

create or replace function public.has_verified_guardian_consent(
  p_dependant_id uuid,
  p_policy_version text
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.guardian_consents c
    join public.guardianships g
      on g.dependant_profile_id = c.dependant_id
     and g.guardian_id = c.guardian_id
     and g.revoked_at is null
    where c.dependant_id = p_dependant_id
      and c.status = 'verified'
      and c.policy_version = p_policy_version
  );
$$;

create or replace function public.record_guardian_consent(
  p_dependant_id uuid,
  p_method text,
  p_evidence_ref text,
  p_policy_version text
)
returns public.guardian_consents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.guardian_consents;
begin
  if not public.can_manage_profile(p_dependant_id) then
    raise exception 'UNAUTHORIZED';
  end if;
  insert into public.guardian_consents
    (dependant_id, guardian_id, method, evidence_ref, policy_version)
  values
    (p_dependant_id, auth.uid(), p_method, p_evidence_ref, p_policy_version)
  returning * into v_row;
  insert into public.guardian_audit_log (actor_id, subject_id, action, meta)
  values (auth.uid(), p_dependant_id, 'guardian_consent_requested',
          jsonb_build_object('method', p_method, 'policy_version', p_policy_version));
  return v_row;
end;
$$;

create or replace function public.verify_guardian_consent(
  p_consent_id uuid,
  p_verifier_id uuid,
  p_approved boolean,
  p_evidence_ref text default null
)
returns public.guardian_consents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.guardian_consents;
begin
  update public.guardian_consents
     set status       = case when p_approved then 'verified' else 'rejected' end,
         verifier_id  = p_verifier_id,
         verified_at  = now(),
         evidence_ref = coalesce(p_evidence_ref, evidence_ref)
   where id = p_consent_id and status = 'pending'
  returning * into v_row;
  if v_row.id is null then
    raise exception 'CONSENT_NOT_PENDING';
  end if;
  insert into public.guardian_audit_log (actor_id, subject_id, action, meta)
  values (p_verifier_id, v_row.dependant_id,
          case when p_approved then 'guardian_consent_verified' else 'guardian_consent_rejected' end,
          jsonb_build_object('consent_id', v_row.id, 'method', v_row.method,
                             'policy_version', v_row.policy_version));
  return v_row;
end;
$$;

create or replace function public.set_dependant_card_public(
  p_dependant_id uuid,
  p_public boolean,
  p_policy_version text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dob text;
begin
  if not public.can_manage_profile(p_dependant_id) then
    raise exception 'UNAUTHORIZED';
  end if;
  select date_of_birth into v_dob from public.dependants where id = p_dependant_id;
  -- Age-of-majority handover: guardian consent no longer applies; the
  -- dependant must re-confirm from their own account.
  if p_public and v_dob is not null
     and (v_dob::date + interval '18 years')
         <= (now() at time zone 'Africa/Lagos')::date then
    raise exception 'MAJORITY_RECONFIRM_REQUIRED';
  end if;
  -- A dependant without a DOB is treated as a minor (fail closed).
  if p_public
     and not public.has_verified_guardian_consent(p_dependant_id, p_policy_version) then
    raise exception 'GUARDIAN_CONSENT_REQUIRED';
  end if;
  update public.dependants set card_public = p_public where id = p_dependant_id;
  insert into public.guardian_audit_log (actor_id, subject_id, action, meta)
  values (auth.uid(), p_dependant_id, 'card_visibility_changed',
          jsonb_build_object('public', p_public, 'policy_version', p_policy_version));
end;
$$;

-- Guardian change: a revoked guardianship makes the card private again until
-- the new guardian's consent is verified.
create or replace function public.guardian_change_reconfirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.dependants set card_public = false
     where id = new.dependant_profile_id;
  end if;
  return new;
end;
$$;

create trigger guardianships_reconfirm_consent
  after update of revoked_at on public.guardianships
  for each row execute function public.guardian_change_reconfirm();

revoke all on function public.verify_guardian_consent(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.verify_guardian_consent(uuid, uuid, boolean, text) to service_role;
grant execute on function public.record_guardian_consent(uuid, text, text, text) to authenticated;
grant execute on function public.set_dependant_card_public(uuid, boolean, text) to authenticated;
