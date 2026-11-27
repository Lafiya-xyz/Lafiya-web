-- Issue #909: bind CHW payout limits to identity-assurance tiers.
--
-- Tiers are ordered: basic < verified < enhanced. Each tier carries a daily
-- and a monthly USDC payout cap. Obligations that would exceed a cap are
-- created as `held` (excess held) instead of `pending`, so they are never
-- picked up by the payout indexer until the CHW upgrades and the hold is
-- released by `release_held_payout_obligations`.

create type public.chw_assurance_tier as enum ('basic', 'verified', 'enhanced');

alter table public.chw_identities
  add column assurance_tier public.chw_assurance_tier not null default 'basic',
  add column assurance_tier_updated_at timestamptz not null default now();

alter type public.payout_obligation_status add value if not exists 'held';

alter table public.payout_obligations
  add column held_reason text,
  add column released_at timestamptz;

create index payout_obligations_held_idx
  on public.payout_obligations(chw_id, created_at) where status = 'held';

-- Tier policy. Caps are per UTC calendar day / month, in USDC.
create table public.chw_payout_tier_limits (
  tier public.chw_assurance_tier primary key,
  daily_limit_usdc numeric(20,7) not null check (daily_limit_usdc >= 0),
  monthly_limit_usdc numeric(20,7) not null check (monthly_limit_usdc >= 0),
  constraint chw_payout_tier_limits_ordered check (daily_limit_usdc <= monthly_limit_usdc)
);

insert into public.chw_payout_tier_limits(tier, daily_limit_usdc, monthly_limit_usdc) values
  ('basic', 5, 50),
  ('verified', 25, 250),
  ('enhanced', 100, 1000);

alter table public.chw_payout_tier_limits enable row level security;
revoke all on public.chw_payout_tier_limits from anon, authenticated;
grant select on public.chw_payout_tier_limits to service_role;

-- Tier ordering helper: 0 = basic, 1 = verified, 2 = enhanced.
create function public.chw_assurance_tier_rank(p_tier public.chw_assurance_tier)
returns integer language sql immutable set search_path = '' as $$
  select case p_tier when 'basic' then 0 when 'verified' then 1 else 2 end;
$$;

-- Sum of obligations that count against a CHW's cap in a window. Held rows
-- count too: they are committed payouts, just not yet released.
create function public.chw_payout_committed_usdc(
  p_chw_id uuid,
  p_since timestamptz
) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(o.amount_usdc), 0)
  from public.payout_obligations o
  where o.chw_id = p_chw_id
    and o.created_at >= p_since
    and o.status in ('pending', 'held', 'settled');
$$;

-- Decide whether a new obligation for p_chw_id may be released immediately.
-- Returns null when within limits, otherwise the hold reason code.
create function public.chw_payout_limit_hold_reason(
  p_chw_id uuid,
  p_amount_usdc numeric,
  p_at timestamptz default now()
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tier public.chw_assurance_tier;
  v_limits public.chw_payout_tier_limits;
  v_day_start timestamptz := date_trunc('day', p_at at time zone 'UTC') at time zone 'UTC';
  v_month_start timestamptz := date_trunc('month', p_at at time zone 'UTC') at time zone 'UTC';
begin
  select assurance_tier into v_tier from public.chw_identities where chw_id = p_chw_id;
  if v_tier is null then return 'TIER_UNKNOWN'; end if;
  select * into v_limits from public.chw_payout_tier_limits where tier = v_tier;
  if public.chw_payout_committed_usdc(p_chw_id, v_day_start) + p_amount_usdc > v_limits.daily_limit_usdc then
    return 'DAILY_LIMIT_EXCEEDED';
  end if;
  if public.chw_payout_committed_usdc(p_chw_id, v_month_start) + p_amount_usdc > v_limits.monthly_limit_usdc then
    return 'MONTHLY_LIMIT_EXCEEDED';
  end if;
  return null;
end;
$$;

-- Service-layer entry point: create an obligation, holding it when the CHW's
-- tier cap would be exceeded. Idempotent on eligibility_key.
create function public.create_payout_obligation(
  p_evidence_id uuid,
  p_intent_id uuid,
  p_chw_id uuid,
  p_recipient_address text,
  p_amount_usdc numeric,
  p_asset_identifier text,
  p_sponsor_pool text,
  p_eligibility_key text
) returns public.payout_obligations
language plpgsql security definer set search_path = '' as $$
declare
  v_hold text;
  v_obligation public.payout_obligations;
begin
  -- Serialize per CHW so concurrent inserts cannot both pass the cap check.
  perform pg_advisory_xact_lock(hashtextextended(p_chw_id::text, 0));
  v_hold := public.chw_payout_limit_hold_reason(p_chw_id, p_amount_usdc);
  insert into public.payout_obligations(evidence_id, intent_id, chw_id, recipient_address, amount_usdc,
    asset_identifier, sponsor_pool, eligibility_key, status, held_reason)
  values(p_evidence_id, p_intent_id, p_chw_id, p_recipient_address, p_amount_usdc,
    p_asset_identifier, p_sponsor_pool, p_eligibility_key,
    case when v_hold is null then 'pending'::public.payout_obligation_status
         else 'held'::public.payout_obligation_status end,
    v_hold)
  on conflict(eligibility_key) do nothing
  returning * into v_obligation;
  if v_obligation.id is null then
    select * into v_obligation from public.payout_obligations where eligibility_key = p_eligibility_key;
  end if;
  return v_obligation;
end;
$$;

-- Upgrade a CHW's tier, then release held obligations oldest-first while the
-- new caps allow it. Downgrades never release anything.
create function public.set_chw_assurance_tier(
  p_chw_id uuid,
  p_tier public.chw_assurance_tier
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_previous public.chw_assurance_tier;
  v_held public.payout_obligations;
  v_released integer := 0;
begin
  select assurance_tier into v_previous from public.chw_identities where chw_id = p_chw_id for update;
  if v_previous is null then raise exception using errcode = 'P0002', message = 'CHW_NOT_FOUND'; end if;
  update public.chw_identities
    set assurance_tier = p_tier, assurance_tier_updated_at = now(), updated_at = now()
    where chw_id = p_chw_id;
  if public.chw_assurance_tier_rank(p_tier) <= public.chw_assurance_tier_rank(v_previous) then
    return 0;
  end if;
  for v_held in
    select * from public.payout_obligations
    where chw_id = p_chw_id and status = 'held'
    order by created_at asc, id asc
    for update
  loop
    if public.chw_payout_limit_hold_reason(p_chw_id, v_held.amount_usdc) is not null then
      continue;
    end if;
    update public.payout_obligations
      set status = 'pending', released_at = now(), held_reason = null
      where id = v_held.id;
    v_released := v_released + 1;
  end loop;
  return v_released;
end;
$$;

-- CHW-facing projection: own tier, caps, current usage, and upgrade path.
create function public.get_my_payout_tier()
returns table (
  tier public.chw_assurance_tier,
  daily_limit_usdc numeric,
  monthly_limit_usdc numeric,
  daily_used_usdc numeric,
  monthly_used_usdc numeric,
  held_count integer,
  held_total_usdc numeric,
  next_tier public.chw_assurance_tier
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tier public.chw_assurance_tier;
  v_day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  v_month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'AUTH_REQUIRED'; end if;
  select assurance_tier into v_tier from public.chw_identities where chw_id = auth.uid();
  if v_tier is null then raise exception using errcode = '42501', message = 'CHW_NOT_AUTHORIZED'; end if;
  return query
    select v_tier, l.daily_limit_usdc, l.monthly_limit_usdc,
      public.chw_payout_committed_usdc(auth.uid(), v_day_start),
      public.chw_payout_committed_usdc(auth.uid(), v_month_start),
      (select count(*)::integer from public.payout_obligations o
        where o.chw_id = auth.uid() and o.status = 'held'),
      (select coalesce(sum(o.amount_usdc), 0) from public.payout_obligations o
        where o.chw_id = auth.uid() and o.status = 'held'),
      case v_tier when 'basic' then 'verified'::public.chw_assurance_tier
                  when 'verified' then 'enhanced'::public.chw_assurance_tier
                  else null end
    from public.chw_payout_tier_limits l where l.tier = v_tier;
end;
$$;

-- Funder-facing aggregate: CHW count and settled USDC per tier for a period.
create function public.funder_tier_distribution(
  p_period_start timestamptz,
  p_period_end timestamptz
) returns table (
  tier public.chw_assurance_tier,
  chw_count integer,
  settled_payouts_count integer,
  settled_total_usdc numeric
)
language sql stable security definer set search_path = '' as $$
  select c.assurance_tier,
    count(distinct c.chw_id)::integer,
    count(o.id)::integer,
    coalesce(sum(o.amount_usdc), 0)
  from public.chw_identities c
  left join public.payout_obligations o
    on o.chw_id = c.chw_id and o.status = 'settled'
    and o.created_at >= p_period_start and o.created_at < p_period_end
  group by c.assurance_tier
  order by public.chw_assurance_tier_rank(c.assurance_tier);
$$;

revoke all on function public.chw_assurance_tier_rank(public.chw_assurance_tier),
  public.chw_payout_committed_usdc(uuid, timestamptz),
  public.chw_payout_limit_hold_reason(uuid, numeric, timestamptz),
  public.create_payout_obligation(uuid, uuid, uuid, text, numeric, text, text, text),
  public.set_chw_assurance_tier(uuid, public.chw_assurance_tier),
  public.get_my_payout_tier(),
  public.funder_tier_distribution(timestamptz, timestamptz) from public;
grant execute on function public.get_my_payout_tier() to authenticated;
grant execute on function public.chw_assurance_tier_rank(public.chw_assurance_tier),
  public.chw_payout_committed_usdc(uuid, timestamptz),
  public.chw_payout_limit_hold_reason(uuid, numeric, timestamptz),
  public.create_payout_obligation(uuid, uuid, uuid, text, numeric, text, text, text),
  public.set_chw_assurance_tier(uuid, public.chw_assurance_tier),
  public.funder_tier_distribution(timestamptz, timestamptz) to service_role;

-- Held obligations are not payable: the settlement matcher only sees pending.
create or replace view public.payout_obligation_reconciliation as
select
  date_trunc('day', created_at) as reporting_day,
  count(*) as obligations,
  count(*) filter (where status = 'settled') as settled,
  count(*) filter (where status = 'pending') as pending,
  count(*) filter (where status = 'held') as held,
  count(*) filter (where status = 'quarantined') as quarantined,
  count(*) filter (where status = 'adjusted') as explicitly_adjusted,
  count(*) = (
    count(*) filter (where status = 'settled') + count(*) filter (where status = 'pending') +
    count(*) filter (where status = 'held') + count(*) filter (where status = 'quarantined') +
    count(*) filter (where status = 'adjusted')
  ) as reconciled
from public.payout_obligations group by date_trunc('day', created_at);
revoke all on public.payout_obligation_reconciliation from anon, authenticated;
grant select on public.payout_obligation_reconciliation to service_role;
