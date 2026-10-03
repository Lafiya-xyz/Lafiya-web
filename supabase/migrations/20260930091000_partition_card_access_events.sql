-- Issue #513: partition the high-volume card scan audit stream by month.
-- The default partition makes the migration safe for historical rows whose
-- timestamp predates the first managed monthly partition.
alter table public.card_access_events rename to card_access_events_unpartitioned;

create table public.card_access_events (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  capability_id uuid references public.emergency_capabilities(id) on delete set null,
  access_kind text not null check (access_kind in ('legacy', 'capability')),
  outcome text not null check (outcome in ('served', 'inactive')),
  observed_at timestamptz not null default now(),
  primary key (id, observed_at)
) partition by range (observed_at);

create table public.card_access_events_2026_09
  partition of public.card_access_events
  for values from ('2026-09-01 00:00:00+00') to ('2026-10-01 00:00:00+00');
create table public.card_access_events_2026_10
  partition of public.card_access_events
  for values from ('2026-10-01 00:00:00+00') to ('2026-11-01 00:00:00+00');
create table public.card_access_events_2026_11
  partition of public.card_access_events
  for values from ('2026-11-01 00:00:00+00') to ('2026-12-01 00:00:00+00');
create table public.card_access_events_2026_12
  partition of public.card_access_events
  for values from ('2026-12-01 00:00:00+00') to ('2027-01-01 00:00:00+00');
create table public.card_access_events_default
  partition of public.card_access_events default;

alter table public.card_access_events_2026_09 enable row level security;
alter table public.card_access_events_2026_10 enable row level security;
alter table public.card_access_events_2026_11 enable row level security;
alter table public.card_access_events_2026_12 enable row level security;
alter table public.card_access_events_default enable row level security;

create index card_access_events_owner_time_idx
  on public.card_access_events(user_id, observed_at desc);

insert into public.card_access_events
  (id, user_id, capability_id, access_kind, outcome, observed_at)
select id, user_id, capability_id, access_kind, outcome, observed_at
from public.card_access_events_unpartitioned;

drop table public.card_access_events_unpartitioned;

alter table public.card_access_events enable row level security;
create policy card_access_events_select_own on public.card_access_events
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.card_access_events from anon, authenticated;
grant select on public.card_access_events to authenticated;
grant select, insert, update, delete on public.card_access_events to service_role;

create or replace function public.ensure_card_access_event_partition(p_month date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (v_start + interval '1 month')::date;
  v_name text := format('card_access_events_%s', to_char(v_start, 'YYYY_MM'));
begin
  if v_start < date '2020-01-01' then
    raise exception 'partition month is outside the supported range';
  end if;
  execute 'alter table public.card_access_events detach partition public.card_access_events_default';
  execute format(
    'create table if not exists public.%I partition of public.card_access_events for values from (%L) to (%L)',
    v_name, v_start::timestamptz, v_end::timestamptz
  );
  execute 'alter table public.card_access_events attach partition public.card_access_events_default default';
end;
$$;

create or replace function public.maintain_card_access_event_partitions(
  p_retention_months integer default 3
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', now())::date;
  v_partition record;
  v_cutoff date := (v_month - make_interval(months => p_retention_months))::date;
begin
  if p_retention_months < 1 then
    raise exception 'retention must be at least one month';
  end if;
  perform public.ensure_card_access_event_partition(v_month);
  perform public.ensure_card_access_event_partition((v_month + interval '1 month')::date);
  for v_partition in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.card_access_events'::regclass
      and c.relname ~ '^card_access_events_[0-9]{4}_[0-9]{2}$'
      and to_date(right(c.relname, 7), 'YYYY_MM') < v_cutoff
  loop
    execute format('drop table if exists public.%I', v_partition.relname);
  end loop;
end;
$$;

revoke all on function public.ensure_card_access_event_partition(date) from public;
revoke all on function public.maintain_card_access_event_partitions(integer) from public;
grant execute on function public.ensure_card_access_event_partition(date) to service_role;
grant execute on function public.maintain_card_access_event_partitions(integer) to service_role;

comment on table public.card_access_events is
  'Monthly range-partitioned card access audit stream. Run maintain_card_access_event_partitions from the scheduler.';
