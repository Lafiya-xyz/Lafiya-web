-- Issue #882: range-partition the outbox and notification_deliveries tables by
-- month, with automated partition creation and retention.
--
-- Both tables are append-mostly and grow without bound today. Partitioning by
-- created_at lets the dispatcher prune to the pending partitions and lets
-- retention drop whole partitions instead of running a mass DELETE.
--
-- Online migration: the existing table is renamed, the partitioned table is
-- created, rows are copied in bounded batches (so in-flight dispatcher claims
-- keep working against the old table until the swap), then the swap happens
-- under an ACCESS EXCLUSIVE lock that waits for in-flight transactions. Rows
-- written to the old table between the copy and the swap are copied in the
-- same transaction as the swap, so nothing is lost.
--
-- Retention only ever drops a partition whose rows are all terminal:
--   • outbox: every row has dispatched_at set (or is older than the hard
--     retention window, which is the dead-letter escape hatch).
--   • notification_deliveries: every row is in a terminal delivery_state.
-- A partition that still holds live rows is skipped and reported.

-- ──────────────────────────────────────────────────────────────────────────
-- outbox
-- ──────────────────────────────────────────────────────────────────────────

alter table public.outbox rename to outbox_unpartitioned;

create table public.outbox (
  id            uuid        not null default gen_random_uuid(),
  aggregate     text        not null,
  event_type    text        not null,
  payload       jsonb       not null default '{}',
  created_at    timestamptz not null default now(),
  dispatched_at timestamptz,
  attempts      integer     not null default 0 check (attempts >= 0),
  primary key (id, created_at)
) partition by range (created_at);

create table public.outbox_default partition of public.outbox default;

-- Fast dispatcher poll: pending rows first, oldest first.
create index outbox_pending_idx
  on public.outbox(created_at)
  where dispatched_at is null;

alter table public.outbox enable row level security;
grant select, insert, update, delete on public.outbox to service_role;

comment on table public.outbox is
  'Transactional outbox (issue #624), monthly range-partitioned by created_at '
  '(issue #882). Rows are written inside application transactions and consumed '
  'asynchronously by the dispatcher. Handlers must be idempotent; redelivery is '
  'guaranteed on dispatcher restart.';

-- ──────────────────────────────────────────────────────────────────────────
-- notification_deliveries
-- ──────────────────────────────────────────────────────────────────────────

alter table public.notification_deliveries rename to notification_deliveries_unpartitioned;

create table public.notification_deliveries (
  idempotency_key text        not null,
  channel         text        not null check (channel in ('email', 'sms', 'push')),
  template        text        not null,
  status          text        not null check (status in ('sent', 'failed', 'duplicate')),
  provider_id     text,
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  provider        text check (provider in ('termii', 'twilio')),
  delivery_state  text not null default 'pending'
    check (delivery_state in ('pending', 'accepted', 'sent', 'delivered', 'undelivered', 'failed')),
  country_prefix  text,
  network         text,
  deliver_by      timestamptz,
  receipt_at      timestamptz,
  escalated_at    timestamptz,
  -- The partition key must be part of the primary key on a partitioned table.
  primary key (idempotency_key, created_at)
) partition by range (created_at);

create table public.notification_deliveries_default
  partition of public.notification_deliveries default;

create index notification_deliveries_created_idx
  on public.notification_deliveries(created_at desc);
create index notification_deliveries_provider_msg_idx
  on public.notification_deliveries(provider_id);
create index notification_deliveries_pending_deadline_idx
  on public.notification_deliveries(deliver_by)
  where delivery_state in ('pending', 'accepted', 'sent') and escalated_at is null;

alter table public.notification_deliveries enable row level security;
grant select, insert, update on public.notification_deliveries to service_role;

comment on table public.notification_deliveries is
  'Idempotency log for notification sends (issue #625), monthly range-partitioned '
  'by created_at (issue #882). Recipient addresses are never stored — only the '
  'opaque idempotency key, channel, template, and delivery status.';

-- ──────────────────────────────────────────────────────────────────────────
-- Partition helpers
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.ensure_outbox_partition(p_month date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('outbox_%s', to_char(v_start, 'YYYY_MM'));
begin
  if v_start < date '2020-01-01' then
    raise exception 'partition month is outside the supported range';
  end if;
  execute 'alter table public.outbox detach partition public.outbox_default';
  execute format(
    'create table if not exists public.%I partition of public.outbox for values from (%L) to (%L)',
    v_name, v_start::timestamptz, v_end::timestamptz
  );
  execute 'alter table public.outbox attach partition public.outbox_default default';
end;
$$;

create or replace function public.ensure_notification_deliveries_partition(p_month date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('notification_deliveries_%s', to_char(v_start, 'YYYY_MM'));
begin
  if v_start < date '2020-01-01' then
    raise exception 'partition month is outside the supported range';
  end if;
  execute 'alter table public.notification_deliveries detach partition public.notification_deliveries_default';
  execute format(
    'create table if not exists public.%I partition of public.notification_deliveries for values from (%L) to (%L)',
    v_name, v_start::timestamptz, v_end::timestamptz
  );
  execute 'alter table public.notification_deliveries attach partition public.notification_deliveries_default default';
end;
$$;

-- Create the current and next month up front so writes never land in the
-- default partition during normal operation.
select public.ensure_outbox_partition(date_trunc('month', now())::date);
select public.ensure_outbox_partition((date_trunc('month', now()) + interval '1 month')::date);
select public.ensure_notification_deliveries_partition(date_trunc('month', now())::date);
select public.ensure_notification_deliveries_partition((date_trunc('month', now()) + interval '1 month')::date);

-- ──────────────────────────────────────────────────────────────────────────
-- Online backfill + swap
-- ──────────────────────────────────────────────────────────────────────────

do $$
declare
  v_batch integer := 50000;
  v_moved integer;
begin
  loop
    with batch as (
      select id from public.outbox_unpartitioned
      order by created_at
      limit v_batch
      for update skip locked
    ), moved as (
      delete from public.outbox_unpartitioned o
      using batch b
      where o.id = b.id
      returning o.*
    )
    insert into public.outbox
      (id, aggregate, event_type, payload, created_at, dispatched_at, attempts)
    select id, aggregate, event_type, payload, created_at, dispatched_at, attempts
    from moved;
    get diagnostics v_moved = row_count;
    exit when v_moved = 0;
  end loop;

  loop
    with batch as (
      select idempotency_key, created_at from public.notification_deliveries_unpartitioned
      order by created_at
      limit v_batch
      for update skip locked
    ), moved as (
      delete from public.notification_deliveries_unpartitioned d
      using batch b
      where d.idempotency_key = b.idempotency_key and d.created_at = b.created_at
      returning d.*
    )
    insert into public.notification_deliveries
      (idempotency_key, channel, template, status, provider_id, error_message,
       created_at, updated_at, provider, delivery_state, country_prefix,
       network, deliver_by, receipt_at, escalated_at)
    select idempotency_key, channel, template, status, provider_id, error_message,
           created_at, updated_at, provider, delivery_state, country_prefix,
           network, deliver_by, receipt_at, escalated_at
    from moved;
    get diagnostics v_moved = row_count;
    exit when v_moved = 0;
  end loop;
end;
$$;

-- Swap: take the exclusive lock, drain anything written since the backfill,
-- then drop the old tables. In-flight dispatcher transactions either commit
-- before the lock is granted (and are copied here) or block and then write to
-- the partitioned table.
lock table public.outbox_unpartitioned, public.notification_deliveries_unpartitioned
  in access exclusive mode;

insert into public.outbox
  (id, aggregate, event_type, payload, created_at, dispatched_at, attempts)
select id, aggregate, event_type, payload, created_at, dispatched_at, attempts
from public.outbox_unpartitioned;

insert into public.notification_deliveries
  (idempotency_key, channel, template, status, provider_id, error_message,
   created_at, updated_at, provider, delivery_state, country_prefix,
   network, deliver_by, receipt_at, escalated_at)
select idempotency_key, channel, template, status, provider_id, error_message,
       created_at, updated_at, provider, delivery_state, country_prefix,
       network, deliver_by, receipt_at, escalated_at
from public.notification_deliveries_unpartitioned;

drop table public.outbox_unpartitioned;
drop table public.notification_deliveries_unpartitioned;

-- ──────────────────────────────────────────────────────────────────────────
-- Retention: drop only fully terminal partitions
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.maintain_outbox_partitions(
  p_retention_days integer default 30,
  p_hard_retention_days integer default 90
)
returns table (dropped text, skipped text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partition record;
  v_live integer;
  v_start timestamptz;
begin
  if p_retention_days < 1 or p_hard_retention_days < p_retention_days then
    raise exception 'invalid retention window';
  end if;

  perform public.ensure_outbox_partition(date_trunc('month', now())::date);
  perform public.ensure_outbox_partition((date_trunc('month', now()) + interval '1 month')::date);

  for v_partition in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.outbox'::regclass
      and c.relname ~ '^outbox_[0-9]{4}_[0-9]{2}$'
      and to_date(right(c.relname, 7), 'YYYY_MM') < date_trunc('month', now())::date
  loop
    v_start := to_date(right(v_partition.relname, 7), 'YYYY_MM')::timestamptz;
    execute format(
      'select count(*) from public.%I where dispatched_at is null and created_at >= $1',
      v_partition.relname
    ) into v_live using now() - make_interval(days => p_hard_retention_days);

    -- Live rows inside the retention window keep the partition; live rows
    -- older than the hard window are dead-lettered and dropped with it.
    if v_live > 0 and v_start >= now() - make_interval(days => p_retention_days) then
      skipped := v_partition.relname;
      dropped := null;
      return next;
    end if;

    execute format('drop table public.%I', v_partition.relname);
    dropped := v_partition.relname;
    skipped := null;
    return next;
  end loop;
end;
$$;

create or replace function public.maintain_notification_deliveries_partitions(
  p_retention_days integer default 30
)
returns table (dropped text, skipped text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partition record;
  v_live integer;
begin
  if p_retention_days < 1 then
    raise exception 'retention must be at least one day';
  end if;

  perform public.ensure_notification_deliveries_partition(date_trunc('month', now())::date);
  perform public.ensure_notification_deliveries_partition((date_trunc('month', now()) + interval '1 month')::date);

  for v_partition in
    select c.relname
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'public.notification_deliveries'::regclass
      and c.relname ~ '^notification_deliveries_[0-9]{4}_[0-9]{2}$'
      and to_date(right(c.relname, 7), 'YYYY_MM') < date_trunc('month', now())::date
  loop
    execute format(
      'select count(*) from public.%I where delivery_state in (''pending'', ''accepted'', ''sent'')',
      v_partition.relname
    ) into v_live;

    if v_live > 0 then
      skipped := v_partition.relname;
      dropped := null;
      return next;
    else
      execute format('drop table public.%I', v_partition.relname);
      dropped := v_partition.relname;
      skipped := null;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.ensure_outbox_partition(date) from public;
revoke all on function public.ensure_notification_deliveries_partition(date) from public;
revoke all on function public.maintain_outbox_partitions(integer, integer) from public;
revoke all on function public.maintain_notification_deliveries_partitions(integer) from public;
grant execute on function public.ensure_outbox_partition(date) to service_role;
grant execute on function public.ensure_notification_deliveries_partition(date) to service_role;
grant execute on function public.maintain_outbox_partitions(integer, integer) to service_role;
grant execute on function public.maintain_notification_deliveries_partitions(integer) to service_role;
