-- Issue #949: privacy-safe funnel analytics.
--
-- Aggregate-only daily counters for a closed event taxonomy. There is
-- deliberately no user id, session id, IP, user agent, card id, capability
-- token or free-text column: the primary key is (day, event, dimension), so
-- the schema itself makes per-person tracking impossible. Writes go through
-- the service-role client only (lib/analytics/funnel.ts); reads go through
-- funnel_daily_counts(), which applies small-cell suppression.
create table if not exists public.funnel_daily_counts (
  day date not null,
  event text not null check (
    event in (
      'onboarding_step_reached',
      'card_published',
      'scan_rendered',
      'scan_failed',
      'scan_offline'
    )
  ),
  -- Coarse, non-identifying dimension (e.g. 'profile', 'legacy', 'capability').
  dimension text not null check (dimension ~ '^[a-z_]{1,32}$'),
  count bigint not null default 0 check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, event, dimension)
);

comment on table public.funnel_daily_counts is
  'Issue #949: aggregate-only daily funnel counters. No identifiers are stored -- the key is (day, event, dimension) with a closed event taxonomy and a coarse dimension. Written only via the service-role client from lib/analytics/funnel.ts.';

alter table public.funnel_daily_counts enable row level security;

-- Atomic increment for one (day, event, dimension) cell. now() is used so the
-- day bucket is consistent regardless of which serverless instance calls in.
create or replace function public.funnel_increment(
  p_event text,
  p_dimension text,
  p_amount integer default 1
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.funnel_daily_counts as f (day, event, dimension, count, updated_at)
  values (current_date, p_event, p_dimension, greatest(p_amount, 0), now())
  on conflict (day, event, dimension) do update
    set count = f.count + greatest(p_amount, 0),
        updated_at = now();
$$;

comment on function public.funnel_increment(text, text, integer) is
  'Issue #949: atomically increments one aggregate funnel cell for the current UTC day. Rejects unknown events/dimensions via the table check constraints.';

revoke all on function public.funnel_increment(text, text, integer) from public;

-- Dashboard read path: daily counts with small-cell suppression. Cells below
-- p_min_cell are reported as NULL (suppressed) so a maintainer can never read
-- a count that could describe one or two people.
create or replace function public.funnel_daily_counts(
  p_from date,
  p_to date,
  p_min_cell integer default 5
)
returns table (day date, event text, dimension text, count bigint)
language sql
security definer
set search_path = ''
as $$
  select f.day,
         f.event,
         f.dimension,
         case when f.count < greatest(p_min_cell, 1) then null else f.count end
  from public.funnel_daily_counts f
  where f.day >= p_from and f.day <= p_to
  order by f.day, f.event, f.dimension;
$$;

comment on function public.funnel_daily_counts(date, date, integer) is
  'Issue #949: aggregate funnel counters for a date range with small-cell suppression (counts below p_min_cell are returned as NULL).';

revoke all on function public.funnel_daily_counts(date, date, integer) from public;
