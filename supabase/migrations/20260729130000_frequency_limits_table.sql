-- frequency_limits: durable, cross-instance fixed-window request counter.
--
-- Distinct from rate_limits (see 20260729120000_rate_limits_table.sql),
-- which is a failure/backoff *lockout* purpose-built for the sign-in
-- brute-force defense (only failures count, success clears the counter).
-- This table counts every attempt -- successful or not -- inside a rolling
-- window, for capping plain request *frequency* per key. First consumer:
-- app/api/profile/photo/route.ts, which caps how many avatar uploads a
-- single authenticated user can push through in a short window so that a
-- burst of individually-within-budget uploads can't still exhaust shared
-- CPU/memory by sheer parallelism (see lib/frequency-limit.ts).
--
-- Same atomicity approach as rate_limit_record_failure: a single
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so concurrent callers for
-- the same key serialize on Postgres's own row lock and never lose an
-- increment, with no explicit SELECT ... FOR UPDATE needed.
create table if not exists public.frequency_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0 check (count >= 0)
);

comment on table public.frequency_limits is
  'Durable, cross-instance fixed-window request counter (lib/frequency-limit.ts). Counts every attempt in a rolling window, unlike rate_limits which only counts failures. Written only via the service-role client from server-only code -- never exposed to anon/authenticated clients.';

-- RLS enabled with no policies and no grants: default-deny for anon/
-- authenticated, matching rate_limits. Only the service role (which
-- bypasses RLS) reads/writes this table.
alter table public.frequency_limits enable row level security;

-- Atomic check-and-increment for a fixed window of p_window_seconds
-- starting at whichever attempt first opens it. Once the window elapses,
-- the next attempt opens a fresh window with count reset to 1 rather than
-- decaying gradually -- simple and sufficient for capping short upload
-- bursts, not a general-purpose sliding-window limiter.
create or replace function public.frequency_limit_check_and_increment(
  p_key text,
  p_max_count integer,
  p_window_seconds integer
)
returns table (allowed boolean, count integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_count integer;
begin
  insert into public.frequency_limits as fl (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case
          when fl.window_start + (p_window_seconds * interval '1 second') <= v_now
            then v_now
          else fl.window_start
        end,
        count = case
          when fl.window_start + (p_window_seconds * interval '1 second') <= v_now
            then 1
          else fl.count + 1
        end
  returning fl.window_start, fl.count into v_window_start, v_count;

  return query select
    v_count <= p_max_count,
    v_count,
    case
      when v_count <= p_max_count then 0
      else greatest(
        0,
        ceil(extract(epoch from (v_window_start + (p_window_seconds * interval '1 second') - v_now)))
      )::integer
    end;
end;
$$;

comment on function public.frequency_limit_check_and_increment(text, integer, integer) is
  'Atomically increments the request count for a fixed window of p_window_seconds on p_key, resetting the window once it elapses, and returns whether this attempt is within p_max_count along with a retry_after_seconds hint. A single INSERT ... ON CONFLICT DO UPDATE so concurrent callers for the same key never lose an increment.';

-- No grant to anon/authenticated: this function is called only via the
-- service-role client from lib/frequency-limit.ts (server-only, never
-- reachable from the browser).
revoke all on function public.frequency_limit_check_and_increment(text, integer, integer) from public;
