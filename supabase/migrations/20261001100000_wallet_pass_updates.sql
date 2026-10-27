-- Wallet pass update web service (#771). See lib/wallet-passes/updates.ts.
--
-- wallet_passes.serial is the capability token digest (the pass serial
-- number), never the raw token. The barcode URL is needed to re-render an
-- updated pass, so it is kept only as AES-256-GCM ciphertext under a server
-- key; it is deleted with the row by purge_voided_wallet_passes(). Rows intentionally do not
-- cascade with emergency_capabilities/auth.users: a voided row must outlive
-- the account long enough for devices to fetch the voided pass, after which
-- purge_voided_wallet_passes() removes it.
create table if not exists public.wallet_passes (
  serial text primary key check (serial ~ '^[0-9a-f]{64}$'),
  barcode_ciphertext text not null,
  updated_at timestamptz not null default now(),
  last_push_at timestamptz,
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.wallet_pass_registrations (
  device_library_id text not null check (device_library_id ~ '^[A-Za-z0-9]{1,64}$'),
  serial text not null references public.wallet_passes (serial) on delete cascade,
  push_token text not null check (push_token ~ '^[0-9a-fA-F]{16,200}$'),
  created_at timestamptz not null default now(),
  primary key (device_library_id, serial)
);

create index if not exists wallet_pass_registrations_serial_idx
  on public.wallet_pass_registrations (serial);

-- Service-role only: no anon/authenticated access at all.
alter table public.wallet_passes enable row level security;
alter table public.wallet_pass_registrations enable row level security;
revoke all on public.wallet_passes from anon, authenticated;
revoke all on public.wallet_pass_registrations from anon, authenticated;

-- Enqueue one outbox event per live pass when the owner's card changes. The
-- dispatcher coalesces pushes, so a burst of edits yields at most one push
-- per window. Payload holds only the serial (a capability digest).
create or replace function public.enqueue_wallet_pass_updates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.outbox (aggregate, event_type, payload)
  select 'wallet_pass', 'card_changed', jsonb_build_object('serial', wp.serial)
    from public.wallet_passes wp
    join public.emergency_capabilities ec on ec.token_digest = wp.serial
   where ec.user_id = new.user_id
     and wp.voided_at is null
     and exists (
       select 1 from public.wallet_pass_registrations r where r.serial = wp.serial
     );
  return new;
end;
$$;

drop trigger if exists profiles_wallet_pass_updates on public.profiles;
create trigger profiles_wallet_pass_updates
  after update on public.profiles
  for each row
  when (old is distinct from new)
  execute function public.enqueue_wallet_pass_updates();

create or replace function public.purge_voided_wallet_passes(p_older_than interval default '30 days')
returns integer
language sql
security definer
set search_path = ''
as $$
  with purged as (
    delete from public.wallet_passes
     where voided_at is not null and voided_at < now() - p_older_than
    returning 1
  )
  select count(*)::integer from purged;
$$;

revoke all on function public.enqueue_wallet_pass_updates() from public, anon, authenticated;
revoke all on function public.purge_voided_wallet_passes(interval) from public, anon, authenticated;
grant execute on function public.purge_voided_wallet_passes(interval) to service_role;
