-- GCRA (Generic Cell Rate Algorithm) rate-limiter backed by Postgres (issue #793).
--
-- Single table + function replace per-route in-memory counters with an
-- atomic, distributed GCRA implementation so every Vercel instance shares
-- the same quota state.
--
-- Algorithm:
--   emission_interval = period_seconds / burst
--   new_tat           = GREATEST(COALESCE(tat, now), now) + emission_interval * cost
--   allowed           = new_tat - now <= burst * emission_interval
--
-- Stores only one row per (key); the TAT column is the entire state.

create table if not exists public.gcra_limits (
  key         text        primary key,
  tat         timestamptz not null,
  updated_at  timestamptz not null default now()
);

comment on table public.gcra_limits is
  'GCRA theoretical-arrival-time store. One row per rate-limit key. '
  'No PHI — keys must be opaque (hashed IPs, aggregate identifiers, etc.).';

-- Service-role only; no client role should touch this directly.
revoke all on public.gcra_limits from anon, authenticated;

-- Atomically advance the GCRA TAT for `p_key` and return the decision.
create or replace function public.gcra_consume(
  p_key             text,
  p_burst           integer,
  p_period_seconds  numeric,
  p_cost            integer default 1
)
returns table (
  allowed               boolean,
  remaining             integer,
  retry_after_seconds   integer,
  reset_at              timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emission_interval  interval;
  v_burst_interval     interval;
  v_now                timestamptz := clock_timestamp();
  v_old_tat            timestamptz;
  v_base_tat           timestamptz;
  v_new_tat            timestamptz;
  v_allowed            boolean;
  v_remaining          integer;
  v_retry_after        integer;
  v_reset_at           timestamptz;
begin
  -- Compute intervals from the caller-supplied policy.
  v_emission_interval := make_interval(secs => p_period_seconds::float / p_burst);
  v_burst_interval    := v_emission_interval * p_burst;

  -- Claim (or initialise) the TAT row atomically.
  insert into public.gcra_limits (key, tat)
  values (p_key, v_now + v_emission_interval * p_cost)
  on conflict (key) do update
    set
      tat        = greatest(excluded.tat,
                            greatest(public.gcra_limits.tat, v_now)
                              + v_emission_interval * p_cost),
      updated_at = v_now
  returning gcra_limits.tat into v_new_tat;

  -- The TAT *before* this update (reconstruct from new_tat).
  v_base_tat := v_new_tat - v_emission_interval * p_cost;
  -- Would-be new TAT if we hadn't clamped.
  v_old_tat  := v_base_tat;

  -- Decision: allowed iff the new TAT is within the burst window from now.
  v_allowed := v_new_tat - v_now <= v_burst_interval;

  if v_allowed then
    -- remaining ≈ how many more single-cost requests can fit before the window fills.
    v_remaining   := greatest(0,
                       floor(extract(epoch from (v_burst_interval - (v_new_tat - v_now)))
                             / extract(epoch from v_emission_interval))::integer);
    v_retry_after := 0;
    v_reset_at    := v_now + (v_burst_interval - (v_new_tat - v_now));
  else
    -- Roll back: undo the write so a denied request doesn't consume quota.
    update public.gcra_limits
      set tat = v_old_tat, updated_at = v_now
    where key = p_key;

    v_remaining   := 0;
    v_retry_after := greatest(1,
                       ceil(extract(epoch from (v_new_tat - v_now - v_burst_interval)))::integer);
    v_reset_at    := v_now + (v_new_tat - v_now - v_burst_interval);
  end if;

  return query select v_allowed, v_remaining, v_retry_after, v_reset_at;
end;
$$;

comment on function public.gcra_consume(text, integer, numeric, integer) is
  'GCRA consume: atomically advance the TAT for p_key and return '
  '{ allowed, remaining, retry_after_seconds, reset_at }. '
  'p_burst = max tokens per window, p_period_seconds = window length, '
  'p_cost = tokens to deduct (default 1).';
