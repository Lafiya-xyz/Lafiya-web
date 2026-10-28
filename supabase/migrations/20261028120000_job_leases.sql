-- Issue #694: leased job runner with heartbeats and a stuck-job reaper.
-- Issue #693: `last_success_at` doubles as the per-job heartbeat row read by
-- the readiness probe to detect missed scheduled runs.

create table if not exists public.job_leases (
  job_name text primary key,
  holder text,
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz not null default now(),
  takeover_count integer not null default 0,
  last_success_at timestamptz
);

alter table public.job_leases enable row level security;
revoke all on public.job_leases from anon, authenticated;
grant select, insert, update on public.job_leases to service_role;

-- Acquire (or renew) a lease. The row lock serializes concurrent acquirers so
-- two invocations can never both hold the same job. `took_over` is true when
-- an expired lease held by a different runner was taken over.
create or replace function public.acquire_job_lease(
  p_job_name text,
  p_holder text,
  p_ttl_seconds integer
)
returns table (acquired boolean, took_over boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holder text;
  v_expires timestamptz;
  v_took_over boolean;
begin
  insert into public.job_leases (job_name) values (p_job_name)
  on conflict (job_name) do nothing;

  select l.holder, l.expires_at into v_holder, v_expires
  from public.job_leases l
  where l.job_name = p_job_name
  for update;

  if v_holder is not null and v_holder <> p_holder and v_expires > now() then
    return query select false, false;
    return;
  end if;

  v_took_over := v_holder is not null and v_holder <> p_holder;

  update public.job_leases
  set holder = p_holder,
      acquired_at = case when v_holder = p_holder then acquired_at else now() end,
      heartbeat_at = now(),
      expires_at = now() + make_interval(secs => p_ttl_seconds),
      takeover_count = takeover_count + v_took_over::integer
  where job_name = p_job_name;

  return query select true, v_took_over;
end;
$$;

create or replace function public.heartbeat_job_lease(
  p_job_name text,
  p_holder text,
  p_ttl_seconds integer
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with renewed as (
    update public.job_leases
    set heartbeat_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds)
    where job_name = p_job_name and holder = p_holder and expires_at > now()
    returning 1
  )
  select exists (select 1 from renewed);
$$;

create or replace function public.release_job_lease(
  p_job_name text,
  p_holder text,
  p_succeeded boolean
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.job_leases
  set holder = null,
      expires_at = now(),
      last_success_at = case when p_succeeded then now() else last_success_at end
  where job_name = p_job_name and holder = p_holder;
$$;

-- Record a successful run for jobs that do not hold a lease.
create or replace function public.record_job_success(p_job_name text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.job_leases (job_name, last_success_at)
  values (p_job_name, now())
  on conflict (job_name) do update set last_success_at = now();
$$;

-- Reap expired leases left behind by crashed runners. Returns the reaped job
-- names so the caller can log a takeover event for each.
create or replace function public.reap_expired_job_leases()
returns setof text
language sql
security definer
set search_path = ''
as $$
  update public.job_leases
  set holder = null,
      takeover_count = takeover_count + 1
  where holder is not null and expires_at <= now()
  returning job_name;
$$;

revoke all on function public.acquire_job_lease(text, text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_job_lease(text, text, integer) from public, anon, authenticated;
revoke all on function public.release_job_lease(text, text, boolean) from public, anon, authenticated;
revoke all on function public.record_job_success(text) from public, anon, authenticated;
revoke all on function public.reap_expired_job_leases() from public, anon, authenticated;
grant execute on function public.acquire_job_lease(text, text, integer) to service_role;
grant execute on function public.heartbeat_job_lease(text, text, integer) to service_role;
grant execute on function public.release_job_lease(text, text, boolean) to service_role;
grant execute on function public.record_job_success(text) to service_role;
grant execute on function public.reap_expired_job_leases() to service_role;
