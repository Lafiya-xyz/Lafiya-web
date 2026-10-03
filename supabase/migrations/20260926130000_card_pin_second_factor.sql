-- Issue #631: optional printed-PIN second factor for sensitive card fields.
--
-- A 6-digit PIN is generated per capability issuance (card rotation) and
-- printed on the physical card, apart from the QR code. Only its Argon2id
-- hash is stored here, keyed by the capability (which itself stores only the
-- token digest). Fields the patient lists in
-- disclosure_policy.requires_card_pin are withheld unless the viewer has
-- entered the PIN. Critical fields (see lib/emergency/card-pin.ts) can never
-- be PIN-gated; the list is enforced here too.
--
-- Attempts are reserved atomically before the hash is checked, so at most
-- five wrong PINs can ever be tried per capability, even concurrently. After
-- five failures the PIN is locked until the patient issues a new card.

create table public.emergency_capability_pins (
  capability_id uuid primary key
    references public.emergency_capabilities(id) on delete cascade,
  pin_hash text not null check (pin_hash like '$argon2id$%'),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  locked_at timestamptz,
  unlock_digest text check (unlock_digest ~ '^[0-9a-f]{64}$'),
  unlock_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint emergency_capability_pin_unlock_pair check (
    (unlock_digest is null) = (unlock_expires_at is null)
  )
);

alter table public.emergency_capability_pins enable row level security;
-- The PIN hash is never readable by the patient's session: a leaked hash of
-- a 6-digit PIN is brute-forceable offline.
revoke all on public.emergency_capability_pins from anon, authenticated;
grant select, insert, update, delete on public.emergency_capability_pins to service_role;

-- Fields that may be PIN-gated. Everything else is life-critical and always
-- follows the normal disclosure policy.
create function public.card_pin_gated_fields(p_policy jsonb)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct f), '{}')
  from jsonb_array_elements_text(
    case when jsonb_typeof(p_policy->'requires_card_pin') = 'array'
      then p_policy->'requires_card_pin' else '[]'::jsonb end
  ) f
  where f in ('photo_url', 'medications', 'chronic_conditions');
$$;

-- Card-page gate for a capability: which fields are gated, whether this
-- capability has a PIN, whether it is locked, and whether the presented
-- unlock session is valid.
create function public.get_card_pin_gate(
  p_capability_id uuid, p_unlock_digest text
) returns table (gated_fields text[], has_pin boolean, locked boolean, unlocked boolean)
language sql stable security definer set search_path = '' as $$
  select public.card_pin_gated_fields(p.disclosure_policy),
    pin.capability_id is not null,
    coalesce(pin.failed_attempts >= 5, false),
    coalesce(
      pin.unlock_digest = p_unlock_digest and pin.unlock_expires_at > now(),
      false
    )
  from public.emergency_capabilities c
  join public.profiles p on p.user_id = c.user_id
  left join public.emergency_capability_pins pin on pin.capability_id = c.id
  where c.id = p_capability_id;
$$;

-- Legacy /card/<uuid> links have no PIN, so gated fields are always withheld.
create function public.get_legacy_card_pin_gated_fields(p_card_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select public.card_pin_gated_fields(disclosure_policy)
  from public.profiles where card_public_id = p_card_id;
$$;

create function public.set_card_pin(p_capability_id uuid, p_pin_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.emergency_capability_pins(capability_id, pin_hash)
    values (p_capability_id, p_pin_hash)
  on conflict (capability_id) do update set pin_hash = excluded.pin_hash,
    failed_attempts = 0, locked_at = null, unlock_digest = null,
    unlock_expires_at = null, created_at = now();
end;
$$;

-- Reserves one attempt for an active capability. Returns the hash to verify
-- only while fewer than five attempts have been used; the reservation is
-- released by complete_card_pin_success.
create function public.begin_card_pin_attempt(p_token_digest text)
returns table (capability_id uuid, pin_hash text, allowed boolean)
language plpgsql security definer set search_path = '' as $$
declare v_capability public.emergency_capabilities; v_pin public.emergency_capability_pins;
begin
  select * into v_capability from public.emergency_capabilities c
    where c.token_digest = p_token_digest and c.revoked_at is null
      and c.expires_at > now();
  if not found then return; end if;
  select * into v_pin from public.emergency_capability_pins pin
    where pin.capability_id = v_capability.id for update;
  if not found then return; end if;
  if v_pin.failed_attempts >= 5 then
    return query select v_capability.id, null::text, false;
    return;
  end if;
  update public.emergency_capability_pins pin
    set failed_attempts = pin.failed_attempts + 1,
      locked_at = case when pin.failed_attempts + 1 >= 5 then now() end
    where pin.capability_id = v_capability.id;
  return query select v_capability.id, v_pin.pin_hash, true;
end;
$$;

create function public.complete_card_pin_success(
  p_capability_id uuid, p_unlock_digest text, p_unlock_expires_at timestamptz
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.emergency_capability_pins set failed_attempts = 0,
    locked_at = null, unlock_digest = p_unlock_digest,
    unlock_expires_at = least(p_unlock_expires_at, now() + interval '15 minutes')
  where capability_id = p_capability_id;
end;
$$;

-- Access accountability: PIN outcomes join the existing coarse outcomes.
alter table public.card_access_events drop constraint card_access_events_outcome_check;
alter table public.card_access_events add constraint card_access_events_outcome_check
  check (outcome in ('served', 'inactive', 'pin_success', 'pin_failure', 'pin_locked'));

create or replace function public.record_card_access_event(
  p_capability_id uuid, p_access_kind text, p_outcome text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid;
begin
  if p_access_kind not in ('legacy', 'capability')
     or p_outcome not in ('served', 'inactive', 'pin_success', 'pin_failure', 'pin_locked') then
    raise exception using errcode = '22023', message = 'INVALID_ACCESS_EVENT';
  end if;
  select user_id into v_user_id from public.emergency_capabilities where id = p_capability_id;
  if not found then raise exception using errcode = 'P0002', message = 'CAPABILITY_NOT_FOUND'; end if;
  delete from public.card_access_events where observed_at < now() - interval '90 days';
  insert into public.card_access_events(user_id, capability_id, access_kind, outcome)
    values(v_user_id, p_capability_id, p_access_kind, p_outcome);
end;
$$;

create function public.get_my_card_pin_access_summary()
returns table (pin_successes_30d bigint, pin_failures_30d bigint, last_pin_failure_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select count(*) filter (where outcome = 'pin_success'),
    count(*) filter (where outcome in ('pin_failure', 'pin_locked')),
    max(observed_at) filter (where outcome in ('pin_failure', 'pin_locked'))
  from public.card_access_events
  where user_id = auth.uid() and observed_at >= now() - interval '30 days';
$$;

revoke all on function public.card_pin_gated_fields(jsonb),
  public.get_card_pin_gate(uuid, text), public.get_legacy_card_pin_gated_fields(uuid),
  public.set_card_pin(uuid, text), public.begin_card_pin_attempt(text),
  public.complete_card_pin_success(uuid, text, timestamptz),
  public.get_my_card_pin_access_summary() from public, anon, authenticated;
grant execute on function public.get_card_pin_gate(uuid, text),
  public.get_legacy_card_pin_gated_fields(uuid), public.set_card_pin(uuid, text),
  public.begin_card_pin_attempt(text),
  public.complete_card_pin_success(uuid, text, timestamptz) to service_role;
grant execute on function public.get_my_card_pin_access_summary() to authenticated;
