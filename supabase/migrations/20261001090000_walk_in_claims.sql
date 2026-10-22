-- walk_in_cards: CHW-registered "pending-claim" cards for walk-in patients
-- without email or a smartphone (#770). See lib/account/walk-in-claim.ts.
--
-- The CHW (custodian) can read and edit the limited walk-in fields only while
-- the card is unclaimed. A claim sets owner_id, stamps claimed_at and clears
-- custodian_id in one statement, so custodial access ends atomically with the
-- ownership transfer. Claim codes and PINs are stored only as HMAC-SHA256
-- digests (server-side pepper); the plaintext is shown once to the patient.
create table if not exists public.walk_in_cards (
  id uuid primary key default gen_random_uuid(),
  custodian_id uuid references auth.users (id) on delete set null,
  owner_id uuid references auth.users (id) on delete cascade,
  fields jsonb not null default '{}'::jsonb,
  claim_code_hash text not null unique check (claim_code_hash ~ '^[0-9a-f]{64}$'),
  claim_pin_hash text check (claim_pin_hash is null or claim_pin_hash ~ '^[0-9a-f]{64}$'),
  claim_attempts integer not null default 0 check (claim_attempts >= 0),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((claimed_at is null) = (owner_id is null)),
  check (claimed_at is null or custodian_id is null)
);

create index if not exists walk_in_cards_custodian_idx
  on public.walk_in_cards (custodian_id) where claimed_at is null;
create index if not exists walk_in_cards_expiry_idx
  on public.walk_in_cards (expires_at) where claimed_at is null;

alter table public.walk_in_cards enable row level security;

create policy walk_in_cards_custodian_select on public.walk_in_cards
  for select to authenticated
  using (claimed_at is null and custodian_id = (select auth.uid()));

create policy walk_in_cards_custodian_update on public.walk_in_cards
  for update to authenticated
  using (claimed_at is null and custodian_id = (select auth.uid()))
  with check (claimed_at is null and custodian_id = (select auth.uid()));

create policy walk_in_cards_owner_select on public.walk_in_cards
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- Column-level: custodians may only touch the limited fields payload.
revoke all on public.walk_in_cards from anon, authenticated;
grant select (id, custodian_id, owner_id, fields, expires_at, claimed_at, created_at)
  on public.walk_in_cards to authenticated;
grant update (fields) on public.walk_in_cards to authenticated;

-- Atomic single-use claim. Returns false if already claimed or expired.
create or replace function public.claim_walk_in_card(p_card_id uuid, p_patient_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with claimed as (
    update public.walk_in_cards
       set owner_id = p_patient_id,
           claimed_at = now(),
           custodian_id = null,
           claim_pin_hash = null
     where id = p_card_id
       and claimed_at is null
       and expires_at > now()
    returning 1
  )
  select exists (select 1 from claimed);
$$;

create or replace function public.purge_expired_walk_in_cards()
returns integer
language sql
security definer
set search_path = ''
as $$
  with purged as (
    delete from public.walk_in_cards
     where claimed_at is null and expires_at <= now()
    returning 1
  )
  select count(*)::integer from purged;
$$;

revoke all on function public.claim_walk_in_card(uuid, uuid) from public, anon, authenticated;
revoke all on function public.purge_expired_walk_in_cards() from public, anon, authenticated;
grant execute on function public.claim_walk_in_card(uuid, uuid) to service_role;
grant execute on function public.purge_expired_walk_in_cards() to service_role;
