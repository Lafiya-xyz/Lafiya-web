-- Issue #531: Delegated caregiver model.
-- See docs/adr-004-delegated-caregiver-model.md for full design rationale.
--
-- Creates:
--   public.dependants            — profiles owned by a guardian account
--   public.guardianships         — explicit guardian↔dependant relationships
--   public.guardian_audit_log    — append-only audit trail (actor + subject)
--   can_manage_profile()         — security-definer auth helper used by RPCs
--   create_dependant()           — RPC: guardian creates a dependant (max 5)
--   update_dependant()           — RPC: guardian updates a dependant
--   delete_dependant()           — RPC: guardian soft-deletes a dependant
--   get_my_dependants()          — RPC: list guardian's active dependants
-- RLS policies for all three tables.

-- ---------------------------------------------------------------------------
-- dependants
-- ---------------------------------------------------------------------------

create table public.dependants (
  id                  uuid primary key default gen_random_uuid(),
  guardian_user_id    uuid not null references auth.users(id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 200),
  date_of_birth       text,
  language            text,
  blood_group         text,
  genotype            text,
  allergies           text[] not null default '{}',
  medications         text[] not null default '{}',
  chronic_conditions  text[] not null default '{}',
  emergency_contacts  jsonb not null default '[]',
  -- card_public_id allows generating a shareable QR for a dependant
  card_public_id      uuid not null default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Only the owning guardian can read/write their own dependant rows.
alter table public.dependants enable row level security;

create policy "dependants_select_own"
  on public.dependants for select
  to authenticated
  using (guardian_user_id = auth.uid());

create policy "dependants_insert_own"
  on public.dependants for insert
  to authenticated
  with check (guardian_user_id = auth.uid());

create policy "dependants_update_own"
  on public.dependants for update
  to authenticated
  using (guardian_user_id = auth.uid())
  with check (guardian_user_id = auth.uid());

create policy "dependants_delete_own"
  on public.dependants for delete
  to authenticated
  using (guardian_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- guardianships
-- ---------------------------------------------------------------------------

create table public.guardianships (
  id                    uuid primary key default gen_random_uuid(),
  guardian_id           uuid not null references auth.users(id) on delete cascade,
  dependant_profile_id  uuid not null references public.dependants(id) on delete cascade,
  role                  text not null default 'primary' check (role in ('primary', 'secondary')),
  granted_at            timestamptz not null default now(),
  revoked_at            timestamptz,
  unique (guardian_id, dependant_profile_id)
);

alter table public.guardianships enable row level security;

-- Guardians can read their own active guardianship rows.
create policy "guardianships_select_own"
  on public.guardianships for select
  to authenticated
  using (guardian_id = auth.uid());

-- No direct INSERT/UPDATE/DELETE — managed via security-definer RPCs only.

-- ---------------------------------------------------------------------------
-- guardian_audit_log
-- ---------------------------------------------------------------------------

create table public.guardian_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references auth.users(id),
  subject_id  uuid not null,  -- dependant profile id
  action      text not null,
  meta        jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);

alter table public.guardian_audit_log enable row level security;

-- Audit log is privileged — no direct authenticated read. Service role only.
-- (A future "my actions" endpoint can expose a filtered view if needed.)

-- ---------------------------------------------------------------------------
-- Security-definer helper: can_manage_profile(p_dependant_id)
-- ---------------------------------------------------------------------------
-- Returns true if the calling auth.uid() is an active guardian for the given
-- dependant profile. Used by RPCs to gate writes without re-querying the
-- guardianships table from app code.

create or replace function public.can_manage_profile(p_dependant_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from public.guardianships
    where guardian_id           = auth.uid()
      and dependant_profile_id  = p_dependant_id
      and revoked_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- RPC: create_dependant
-- ---------------------------------------------------------------------------

create or replace function public.create_dependant(
  p_name               text,
  p_date_of_birth      text    default null,
  p_language           text    default null,
  p_blood_group        text    default null,
  p_genotype           text    default null,
  p_allergies          text[]  default '{}',
  p_medications        text[]  default '{}',
  p_chronic_conditions text[]  default '{}',
  p_emergency_contacts jsonb   default '[]'
)
returns public.dependants
language plpgsql
security definer
as $$
declare
  v_count   int;
  v_row     public.dependants;
begin
  -- Enforce the 5-dependant cap per guardian.
  select count(*) into v_count
  from public.dependants
  where guardian_user_id = auth.uid();

  if v_count >= 5 then
    raise exception 'MAX_DEPENDANTS_REACHED'
      using hint = 'A guardian can manage at most 5 dependant profiles.';
  end if;

  -- Insert the dependant row (guardian_user_id is set to the caller).
  insert into public.dependants (
    guardian_user_id, name, date_of_birth, language,
    blood_group, genotype, allergies, medications,
    chronic_conditions, emergency_contacts
  ) values (
    auth.uid(), p_name, p_date_of_birth, p_language,
    p_blood_group, p_genotype, p_allergies, p_medications,
    p_chronic_conditions, p_emergency_contacts
  )
  returning * into v_row;

  -- Insert the guardianship row.
  insert into public.guardianships (guardian_id, dependant_profile_id, role)
  values (auth.uid(), v_row.id, 'primary');

  -- Audit log.
  insert into public.guardian_audit_log (actor_id, subject_id, action, meta)
  values (auth.uid(), v_row.id, 'create_dependant', jsonb_build_object('name', p_name));

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: update_dependant
-- ---------------------------------------------------------------------------

create or replace function public.update_dependant(
  p_dependant_id       uuid,
  p_name               text    default null,
  p_date_of_birth      text    default null,
  p_language           text    default null,
  p_blood_group        text    default null,
  p_genotype           text    default null,
  p_allergies          text[]  default null,
  p_medications        text[]  default null,
  p_chronic_conditions text[]  default null,
  p_emergency_contacts jsonb   default null
)
returns public.dependants
language plpgsql
security definer
as $$
declare
  v_row public.dependants;
begin
  if not public.can_manage_profile(p_dependant_id) then
    raise exception 'UNAUTHORIZED'
      using hint = 'Only an active guardian can update this dependant profile.';
  end if;

  update public.dependants
  set
    name               = coalesce(p_name, name),
    date_of_birth      = coalesce(p_date_of_birth, date_of_birth),
    language           = coalesce(p_language, language),
    blood_group        = coalesce(p_blood_group, blood_group),
    genotype           = coalesce(p_genotype, genotype),
    allergies          = coalesce(p_allergies, allergies),
    medications        = coalesce(p_medications, medications),
    chronic_conditions = coalesce(p_chronic_conditions, chronic_conditions),
    emergency_contacts = coalesce(p_emergency_contacts, emergency_contacts),
    updated_at         = now()
  where id = p_dependant_id
  returning * into v_row;

  -- Audit log.
  insert into public.guardian_audit_log (actor_id, subject_id, action)
  values (auth.uid(), p_dependant_id, 'update_dependant');

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: delete_dependant (hard delete — cascades via FK)
-- ---------------------------------------------------------------------------

create or replace function public.delete_dependant(p_dependant_id uuid)
returns void
language plpgsql
security definer
as $$
begin
  if not public.can_manage_profile(p_dependant_id) then
    raise exception 'UNAUTHORIZED'
      using hint = 'Only an active guardian can delete this dependant profile.';
  end if;

  -- Audit before delete so the record exists when the log is written.
  insert into public.guardian_audit_log (actor_id, subject_id, action)
  values (auth.uid(), p_dependant_id, 'delete_dependant');

  delete from public.dependants where id = p_dependant_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: get_my_dependants
-- ---------------------------------------------------------------------------

create or replace function public.get_my_dependants()
returns setof public.dependants
language sql
security definer
stable
as $$
  select d.*
  from public.dependants d
  join public.guardianships g on g.dependant_profile_id = d.id
  where g.guardian_id  = auth.uid()
    and g.revoked_at   is null
  order by d.created_at;
$$;
