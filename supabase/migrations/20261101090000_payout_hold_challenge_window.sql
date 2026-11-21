-- Issue #906: hold/challenge window for earned CHW payouts.
--
-- Adds a DB-enforced payout state machine
--   earned -> held -> releasable -> paid   (+ disputed, terminal)
-- with per-rate-card and per-trust-tier hold durations, fraud/dispute/
-- spot-check hooks, and a CHW-facing hold status view.
--
-- The existing `payout_obligations.status` enum (pending/settled/quarantined/
-- adjusted) is left untouched: it is the settlement-side lifecycle consumed by
-- the reconciliation job. This migration adds the *release* lifecycle as a
-- separate, additive column so nothing already reading `status` changes
-- behaviour.

create type public.payout_hold_state as enum (
  'earned', 'held', 'releasable', 'paid', 'disputed'
);

-- Hold policy: one row per (rate card, trust tier). `rate_card_id` is the
-- versioned incentive rate card id (lib/chw-protocol/config.ts
-- IncentiveRateCard.id); `trust_tier` is the CHW trust tier. A NULL tier row
-- is the fallback for CHWs with no tier assigned.
create table public.payout_hold_policies (
  id uuid primary key default gen_random_uuid(),
  rate_card_id text not null check (length(rate_card_id) between 1 and 128),
  trust_tier text check (trust_tier is null or length(trust_tier) between 1 and 64),
  hold_seconds integer not null check (hold_seconds between 0 and 2592000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payout_hold_policies_unique
  on public.payout_hold_policies(rate_card_id, coalesce(trust_tier, ''));

comment on table public.payout_hold_policies is
  'Per-rate-card and per-trust-tier challenge window (hold duration) for earned payouts. Issue #906.';

alter table public.payout_obligations
  add column hold_state public.payout_hold_state not null default 'earned',
  add column hold_seconds integer not null default 0 check (hold_seconds >= 0),
  add column hold_started_at timestamptz,
  add column hold_release_at timestamptz,
  add column hold_reason_code text,
  add column disputed_at timestamptz,
  add column dispute_reason_code text,
  add column spot_checked_at timestamptz,
  add column released_at timestamptz,
  add column paid_at timestamptz;

-- Backfill: obligations already settled on-chain are paid; everything else
-- starts its hold window now so no historical obligation is released early.
update public.payout_obligations
  set hold_state = 'paid', paid_at = coalesce(adjusted_at, created_at)
  where status = 'settled';
update public.payout_obligations
  set hold_state = 'held',
      hold_started_at = created_at,
      hold_release_at = created_at
  where status <> 'settled';

create index payout_obligations_hold_state_idx
  on public.payout_obligations(hold_state, hold_release_at);
create index payout_obligations_chw_hold_idx
  on public.payout_obligations(chw_id, hold_state, created_at desc);

-- Shape invariants that hold in every state.
alter table public.payout_obligations
  add constraint payout_obligations_hold_shape check (
    (hold_state = 'earned' and hold_started_at is null and hold_release_at is null)
    or (hold_state in ('held', 'releasable', 'paid', 'disputed')
        and hold_started_at is not null and hold_release_at is not null)
  ),
  add constraint payout_obligations_hold_release_after_start check (
    hold_release_at is null or hold_release_at >= hold_started_at
  ),
  add constraint payout_obligations_dispute_shape check (
    (hold_state = 'disputed') = (disputed_at is not null)
  ),
  add constraint payout_obligations_paid_shape check (
    (hold_state = 'paid') = (paid_at is not null)
  );

-- State machine, enforced on every write. Disputed is terminal for automatic
-- release: only an explicit dispute resolution may leave it, and it may never
-- go straight to paid.
create function public.enforce_payout_hold_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.hold_state not in ('earned', 'held') then
      raise exception using errcode = '23514',
        message = 'PAYOUT_HOLD_INVALID_INITIAL_STATE';
    end if;
    if new.hold_state = 'disputed' then
      new.disputed_at := coalesce(new.disputed_at, now());
    end if;
    return new;
  end if;

  if new.hold_state = old.hold_state then
    return new;
  end if;

  if not (
    (old.hold_state = 'earned' and new.hold_state in ('held', 'disputed'))
    or (old.hold_state = 'held' and new.hold_state in ('releasable', 'disputed'))
    or (old.hold_state = 'releasable' and new.hold_state in ('paid', 'disputed'))
    or (old.hold_state = 'disputed' and new.hold_state in ('held', 'releasable'))
  ) then
    raise exception using errcode = '23514',
      message = 'PAYOUT_HOLD_INVALID_TRANSITION';
  end if;

  -- A disputed payout is never released automatically: leaving `disputed`
  -- requires an explicit resolution reason.
  if old.hold_state = 'disputed' and new.dispute_reason_code is null then
    raise exception using errcode = '23514',
      message = 'PAYOUT_HOLD_DISPUTE_UNRESOLVED';
  end if;

  -- Entering `disputed` always stamps the dispute; leaving it clears the
  -- dispute marker so the shape constraint stays satisfiable.
  if new.hold_state = 'disputed' then
    new.disputed_at := coalesce(new.disputed_at, now());
  else
    new.disputed_at := null;
  end if;

  return new;
end;
$$;

create trigger payout_obligations_hold_transition
  before insert or update of hold_state on public.payout_obligations
  for each row execute function public.enforce_payout_hold_transition();

-- Resolve the hold duration for a CHW from the policy table, falling back to
-- the tier-less row and then to zero (no hold) so a missing policy never
-- blocks a payout forever.
create function public.resolve_payout_hold_seconds(
  p_rate_card_id text,
  p_trust_tier text
) returns integer
language sql stable set search_path = '' as $$
  select coalesce(
    (select hold_seconds from public.payout_hold_policies
      where rate_card_id = p_rate_card_id and trust_tier = p_trust_tier),
    (select hold_seconds from public.payout_hold_policies
      where rate_card_id = p_rate_card_id and trust_tier is null),
    0
  );
$$;

-- Start the challenge window for an earned obligation.
create function public.start_payout_hold(
  p_obligation_id uuid,
  p_rate_card_id text,
  p_trust_tier text default null,
  p_now timestamptz default now()
) returns public.payout_obligations
language plpgsql security definer set search_path = '' as $$
declare
  v_seconds integer;
  v_row public.payout_obligations;
begin
  v_seconds := public.resolve_payout_hold_seconds(p_rate_card_id, p_trust_tier);
  update public.payout_obligations
    set hold_state = 'held',
        hold_seconds = v_seconds,
        hold_started_at = p_now,
        hold_release_at = p_now + make_interval(secs => v_seconds),
        hold_reason_code = 'challenge_window'
    where id = p_obligation_id and hold_state = 'earned'
    returning * into v_row;
  if not found then
    raise exception using errcode = '23514', message = 'PAYOUT_HOLD_NOT_EARNABLE';
  end if;
  return v_row;
end;
$$;

-- Fraud / dispute / spot-check hooks. All three are service-role only.
create function public.dispute_payout(
  p_obligation_id uuid,
  p_reason_code text,
  p_now timestamptz default now()
) returns public.payout_obligations
language plpgsql security definer set search_path = '' as $$
declare v_row public.payout_obligations;
begin
  update public.payout_obligations
    set hold_state = 'disputed',
        disputed_at = p_now,
        dispute_reason_code = p_reason_code,
        hold_started_at = coalesce(hold_started_at, p_now),
        hold_release_at = coalesce(hold_release_at, p_now)
    where id = p_obligation_id and hold_state in ('earned', 'held', 'releasable')
    returning * into v_row;
  if not found then
    raise exception using errcode = '23514', message = 'PAYOUT_HOLD_NOT_DISPUTABLE';
  end if;
  return v_row;
end;
$$;

create function public.resolve_payout_dispute(
  p_obligation_id uuid,
  p_resolution text,
  p_now timestamptz default now()
) returns public.payout_obligations
language plpgsql security definer set search_path = '' as $$
declare v_row public.payout_obligations;
begin
  if p_resolution not in ('release', 'hold') then
    raise exception using errcode = '23514', message = 'PAYOUT_HOLD_INVALID_RESOLUTION';
  end if;
  update public.payout_obligations
    set hold_state = case when p_resolution = 'release' then 'releasable' else 'held' end,
        dispute_reason_code = p_resolution,
        hold_release_at = case when p_resolution = 'release' then p_now else hold_release_at end
    where id = p_obligation_id and hold_state = 'disputed'
    returning * into v_row;
  if not found then
    raise exception using errcode = '23514', message = 'PAYOUT_HOLD_NOT_DISPUTED';
  end if;
  return v_row;
end;
$$;

create function public.record_payout_spot_check(
  p_obligation_id uuid,
  p_now timestamptz default now()
) returns public.payout_obligations
language plpgsql security definer set search_path = '' as $$
declare v_row public.payout_obligations;
begin
  update public.payout_obligations
    set spot_checked_at = p_now
    where id = p_obligation_id
    returning * into v_row;
  if not found then
    raise exception using errcode = '23514', message = 'PAYOUT_HOLD_UNKNOWN_OBLIGATION';
  end if;
  return v_row;
end;
$$;

-- Promote every held obligation whose window has elapsed. Disputed rows are
-- excluded by the state filter, so they can never be released here.
create function public.release_matured_payout_holds(
  p_now timestamptz default now(),
  p_batch_size integer default 500
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_released integer;
begin
  with matured as (
    select id from public.payout_obligations
    where hold_state = 'held' and hold_release_at <= p_now
    order by hold_release_at
    limit greatest(p_batch_size, 1)
    for update skip locked
  )
  update public.payout_obligations o
    set hold_state = 'releasable', released_at = p_now
    from matured m
    where o.id = m.id;
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

-- Mark a releasable obligation paid once the settlement is observed.
create function public.mark_payout_paid(
  p_obligation_id uuid,
  p_now timestamptz default now()
) returns public.payout_obligations
language plpgsql security definer set search_path = '' as $$
declare v_row public.payout_obligations;
begin
  update public.payout_obligations
    set hold_state = 'paid', paid_at = p_now
    where id = p_obligation_id and hold_state = 'releasable'
    returning * into v_row;
  if not found then
    raise exception using errcode = '23514', message = 'PAYOUT_HOLD_NOT_RELEASABLE';
  end if;
  return v_row;
end;
$$;

alter table public.payout_hold_policies enable row level security;
revoke all on public.payout_hold_policies from anon, authenticated;
grant select, insert, update, delete on public.payout_hold_policies to service_role;

revoke all on function public.start_payout_hold(uuid, text, text, timestamptz) from public;
revoke all on function public.dispute_payout(uuid, text, timestamptz) from public;
revoke all on function public.resolve_payout_dispute(uuid, text, timestamptz) from public;
revoke all on function public.record_payout_spot_check(uuid, timestamptz) from public;
revoke all on function public.release_matured_payout_holds(timestamptz, integer) from public;
revoke all on function public.mark_payout_paid(uuid, timestamptz) from public;
grant execute on function public.start_payout_hold(uuid, text, text, timestamptz) to service_role;
grant execute on function public.dispute_payout(uuid, text, timestamptz) to service_role;
grant execute on function public.resolve_payout_dispute(uuid, text, timestamptz) to service_role;
grant execute on function public.record_payout_spot_check(uuid, timestamptz) to service_role;
grant execute on function public.release_matured_payout_holds(timestamptz, integer) to service_role;
grant execute on function public.mark_payout_paid(uuid, timestamptz) to service_role;

-- CHW-facing hold status: one row per obligation with the expected release
-- date. payout_obligations is service-role-only, so this is a SECURITY DEFINER
-- function that filters on auth.uid() rather than a view.
create function public.get_my_payout_holds()
returns table (
  obligation_id uuid,
  amount_usdc numeric,
  asset_identifier text,
  hold_state public.payout_hold_state,
  hold_reason_code text,
  hold_started_at timestamptz,
  expected_release_at timestamptz,
  disputed_at timestamptz,
  dispute_reason_code text,
  spot_checked_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select
    o.id,
    o.amount_usdc,
    o.asset_identifier,
    o.hold_state,
    o.hold_reason_code,
    o.hold_started_at,
    o.hold_release_at,
    o.disputed_at,
    o.dispute_reason_code,
    o.spot_checked_at,
    o.paid_at,
    o.created_at
  from public.payout_obligations o
  where o.chw_id = auth.uid()
  order by o.created_at desc;
$$;

comment on function public.get_my_payout_holds() is
  'CHW-facing payout hold status and expected release date. Issue #906.';

revoke all on function public.get_my_payout_holds() from public;
grant execute on function public.get_my_payout_holds() to authenticated;
