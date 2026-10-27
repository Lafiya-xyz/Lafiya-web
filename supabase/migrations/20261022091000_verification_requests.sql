-- verification_requests: patient-initiated verification visits (#765).
--
-- Workflow: requested -> matched -> scheduled -> verified | declined | expired
-- (matched may fall back to requested). Mirrors lib/chw-protocol/visit-requests.ts.
--
-- Privacy: location is coarse (LGA only). A CHW sees only open requests in
-- their assigned LGAs, and the contact phone is only exposed to the matched
-- CHW when the patient consented (chw_visit_queue()). Closed requests are
-- anonymized after 30 days by anonymize_closed_verification_requests().
create table if not exists public.chw_service_areas (
  chw_id uuid not null references public.chw_identities (chw_id) on delete cascade,
  lga text not null check (lga ~ '^[a-z0-9-]{1,100}$'),
  primary key (chw_id, lga)
);

alter table public.chw_service_areas enable row level security;

create policy chw_service_areas_select_own
  on public.chw_service_areas
  for select
  to authenticated
  using ((select auth.uid()) = chw_id);

revoke all on public.chw_service_areas from anon, authenticated;
grant select on public.chw_service_areas to authenticated;
grant select, insert, update, delete on public.chw_service_areas to service_role;

create table if not exists public.verification_requests (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references auth.users (id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested', 'matched', 'scheduled', 'verified', 'declined', 'expired')),
  lga text not null check (lga ~ '^[a-z0-9-]{1,100}$'),
  preferred_language text check (preferred_language is null or char_length(preferred_language) <= 20),
  contact_preference text not null default 'sms'
    check (contact_preference in ('sms', 'phone_call', 'whatsapp')),
  contact_consent boolean not null default false,
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 32),
  matched_chw_id uuid references public.chw_identities (chw_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  anonymized_at timestamptz
);

create index if not exists verification_requests_lga_open_idx
  on public.verification_requests (lga) where closed_at is null;

-- At most one open request per patient.
create unique index if not exists verification_requests_one_open_idx
  on public.verification_requests (patient_id) where closed_at is null;

alter table public.verification_requests enable row level security;

create policy verification_requests_select_own
  on public.verification_requests
  for select
  to authenticated
  using ((select auth.uid()) = patient_id);

create policy verification_requests_insert_own
  on public.verification_requests
  for insert
  to authenticated
  with check ((select auth.uid()) = patient_id and status = 'requested');

revoke all on public.verification_requests from anon, authenticated;
grant select on public.verification_requests to authenticated;
grant insert (patient_id, lga, preferred_language, contact_preference, contact_consent, contact_phone)
  on public.verification_requests to authenticated;
grant select, insert, update, delete on public.verification_requests to service_role;

create or replace function public.verification_request_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    ('requested', 'matched'), ('requested', 'declined'), ('requested', 'expired'),
    ('matched', 'scheduled'), ('matched', 'requested'), ('matched', 'declined'), ('matched', 'expired'),
    ('scheduled', 'verified'), ('scheduled', 'declined'), ('scheduled', 'expired')
  );
$$;

-- Rejects invalid transitions regardless of the writer (including service_role).
create or replace function public.verification_requests_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if not public.verification_request_transition_allowed(old.status, new.status) then
      raise exception 'invalid verification request transition: % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status in ('verified', 'declined', 'expired') then
      new.closed_at := now();
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger verification_requests_guard
  before update on public.verification_requests
  for each row execute function public.verification_requests_guard();

-- Patient consent toggle for sharing contact details with the matched CHW.
create or replace function public.set_verification_contact_consent(p_request_id uuid, p_consent boolean)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.verification_requests
     set contact_consent = p_consent
   where id = p_request_id
     and patient_id = (select auth.uid())
     and closed_at is null;
$$;

-- Patients may withdraw an open request.
create or replace function public.cancel_my_verification_request(p_request_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.verification_requests
     set status = 'declined'
   where id = p_request_id
     and patient_id = (select auth.uid())
     and closed_at is null;
$$;

-- CHW queue: only open requests in the caller's assigned LGAs, with the
-- minimum fields needed to arrange contact.
create or replace function public.chw_visit_queue()
returns table (
  id uuid,
  status text,
  lga text,
  preferred_language text,
  contact_preference text,
  contact_phone text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.status, r.lga, r.preferred_language, r.contact_preference,
         case when r.contact_consent and r.matched_chw_id = (select auth.uid())
              then r.contact_phone end
    from public.verification_requests r
    join public.chw_service_areas a
      on a.lga = r.lga and a.chw_id = (select auth.uid())
    join public.chw_identities c
      on c.chw_id = a.chw_id and c.status = 'active'
   where r.closed_at is null
   order by r.created_at;
$$;

-- CHW transition for requests in their area (match, schedule, verify, decline).
create or replace function public.chw_transition_verification_request(p_request_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_chw uuid := auth.uid();
begin
  update public.verification_requests r
     set status = p_status,
         matched_chw_id = case when p_status = 'requested' then null
                               when p_status = 'matched' then v_chw
                               else r.matched_chw_id end
   where r.id = p_request_id
     and r.closed_at is null
     and (r.matched_chw_id is null or r.matched_chw_id = v_chw)
     and exists (
       select 1 from public.chw_service_areas a
         join public.chw_identities c on c.chw_id = a.chw_id and c.status = 'active'
        where a.chw_id = v_chw and a.lga = r.lga
     );
  if not found then
    raise exception 'verification request not available' using errcode = 'insufficient_privilege';
  end if;
end;
$$;

-- Retention: expire stale open requests and anonymize closed ones.
create or replace function public.anonymize_closed_verification_requests()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.verification_requests
     set status = 'expired'
   where closed_at is null
     and created_at < now() - interval '30 days';

  update public.verification_requests
     set patient_id = null,
         contact_phone = null,
         contact_consent = false,
         preferred_language = null,
         matched_chw_id = null,
         anonymized_at = now()
   where closed_at is not null
     and anonymized_at is null
     and closed_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.set_verification_contact_consent(uuid, boolean) from public, anon;
revoke all on function public.cancel_my_verification_request(uuid) from public, anon;
revoke all on function public.chw_visit_queue() from public, anon;
revoke all on function public.chw_transition_verification_request(uuid, text) from public, anon;
revoke all on function public.anonymize_closed_verification_requests() from public, anon, authenticated;
grant execute on function public.set_verification_contact_consent(uuid, boolean) to authenticated;
grant execute on function public.cancel_my_verification_request(uuid) to authenticated;
grant execute on function public.chw_visit_queue() to authenticated;
grant execute on function public.chw_transition_verification_request(uuid, text) to authenticated;
grant execute on function public.anonymize_closed_verification_requests() to service_role;
