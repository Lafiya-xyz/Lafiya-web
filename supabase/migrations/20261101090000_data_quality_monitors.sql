-- Issue #892: declarative data-quality monitors for core tables.
--
-- Expectations live as SQL in ops/data-quality/*.sql (one file per domain).
-- Each file defines a view named data_quality_expectations exposing:
--   expectation_id, domain, description, metric_sql (text), direction
--   ('upper' | 'lower'), min_samples, sensitivity (MAD multiplier).
--
-- This migration provides the storage + evaluation engine:
--   * data_quality_runs        — one row per evaluation run (history).
--   * data_quality_observations — one row per expectation per run, with the
--                                 rolling median ± MAD baseline and verdict.
--   * data_quality_alerts      — anomalies (verdict = 'anomaly'), deduplicated
--                                 per expectation until acknowledged.
--   * evaluate_data_quality()  — evaluates every registered expectation.
--
-- Privacy: metrics are aggregate counts/ratios only. No PHI, no capability
-- tokens, no record hashes, no user identifiers are ever stored here.

create table if not exists public.data_quality_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  expectations_evaluated integer not null default 0,
  anomalies integer not null default 0,
  error text
);

create table if not exists public.data_quality_observations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.data_quality_runs(id) on delete cascade,
  expectation_id text not null,
  domain text not null,
  observed_value numeric,
  baseline_median numeric,
  baseline_mad numeric,
  lower_bound numeric,
  upper_bound numeric,
  sample_count integer not null default 0,
  verdict text not null check (verdict in ('ok', 'anomaly', 'insufficient_data', 'error')),
  detail text,
  observed_at timestamptz not null default now()
);
create index if not exists data_quality_observations_expectation_idx
  on public.data_quality_observations(expectation_id, observed_at desc);
create index if not exists data_quality_observations_run_idx
  on public.data_quality_observations(run_id);

create table if not exists public.data_quality_alerts (
  id uuid primary key default gen_random_uuid(),
  expectation_id text not null,
  domain text not null,
  observed_value numeric,
  lower_bound numeric,
  upper_bound numeric,
  baseline_median numeric,
  baseline_mad numeric,
  message text not null,
  raised_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text
);
create unique index if not exists data_quality_alerts_open_unique
  on public.data_quality_alerts(expectation_id) where acknowledged_at is null;
create index if not exists data_quality_alerts_raised_idx
  on public.data_quality_alerts(raised_at desc);

alter table public.data_quality_runs enable row level security;
alter table public.data_quality_observations enable row level security;
alter table public.data_quality_alerts enable row level security;

revoke all on public.data_quality_runs, public.data_quality_observations,
  public.data_quality_alerts from anon, authenticated;
grant select, insert, update, delete on public.data_quality_runs,
  public.data_quality_observations, public.data_quality_alerts to service_role;

-- Evaluate every registered expectation. `p_window_days` is the rolling
-- baseline window; `p_min_samples` the minimum history before a baseline is
-- trusted. Returns the run id.
create or replace function public.evaluate_data_quality(
  p_window_days integer default 28,
  p_min_samples integer default 7
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_expectation record;
  v_value numeric;
  v_median numeric;
  v_mad numeric;
  v_samples integer;
  v_lower numeric;
  v_upper numeric;
  v_verdict text;
  v_anomalies integer := 0;
  v_evaluated integer := 0;
begin
  insert into public.data_quality_runs default values returning id into v_run_id;

  for v_expectation in
    select * from public.data_quality_expectations order by expectation_id
  loop
    v_evaluated := v_evaluated + 1;
    v_value := null;
    v_verdict := 'ok';

    begin
      execute v_expectation.metric_sql into v_value;
    exception when others then
      v_verdict := 'error';
    end;

    -- Rolling baseline from stored history (never from PHI-bearing tables).
    select count(*), percentile_cont(0.5) within group (order by o.observed_value)
      into v_samples, v_median
      from public.data_quality_observations o
      where o.expectation_id = v_expectation.expectation_id
        and o.verdict in ('ok', 'anomaly')
        and o.observed_value is not null
        and o.observed_at >= now() - make_interval(days => p_window_days);

    select percentile_cont(0.5) within group (order by abs(o.observed_value - v_median))
      into v_mad
      from public.data_quality_observations o
      where o.expectation_id = v_expectation.expectation_id
        and o.verdict in ('ok', 'anomaly')
        and o.observed_value is not null
        and o.observed_at >= now() - make_interval(days => p_window_days);

    if v_verdict = 'error' then
      null;
    elsif v_value is null then
      v_verdict := 'error';
    elsif v_samples < greatest(p_min_samples, coalesce(v_expectation.min_samples, 0)) then
      v_verdict := 'insufficient_data';
    else
      -- MAD can be zero on flat series; fall back to a 1-unit floor so a
      -- single-step change is still detectable.
      v_mad := coalesce(v_mad, 0);
      v_lower := v_median - v_expectation.sensitivity * greatest(v_mad, 1);
      v_upper := v_median + v_expectation.sensitivity * greatest(v_mad, 1);
      if v_value < v_lower or v_value > v_upper then
        v_verdict := 'anomaly';
      end if;
    end if;

    insert into public.data_quality_observations (
      run_id, expectation_id, domain, observed_value, baseline_median,
      baseline_mad, lower_bound, upper_bound, sample_count, verdict, detail
    ) values (
      v_run_id, v_expectation.expectation_id, v_expectation.domain, v_value,
      v_median, v_mad, v_lower, v_upper, v_samples, v_verdict,
      v_expectation.description
    );

    if v_verdict = 'anomaly' then
      v_anomalies := v_anomalies + 1;
      insert into public.data_quality_alerts (
        expectation_id, domain, observed_value, lower_bound, upper_bound,
        baseline_median, baseline_mad, message
      ) values (
        v_expectation.expectation_id, v_expectation.domain, v_value,
        v_lower, v_upper, v_median, v_mad,
        format('Data-quality anomaly: %s observed %s outside [%s, %s]',
          v_expectation.expectation_id, v_value, v_lower, v_upper)
      )
      on conflict (expectation_id) where acknowledged_at is null do nothing;
    end if;
  end loop;

  update public.data_quality_runs
  set finished_at = now(),
      expectations_evaluated = v_evaluated,
      anomalies = v_anomalies
  where id = v_run_id;

  return v_run_id;
end;
$$;

revoke all on function public.evaluate_data_quality(integer, integer) from public, anon, authenticated;
grant execute on function public.evaluate_data_quality(integer, integer) to service_role;

comment on table public.data_quality_observations is
  'Issue #892: per-run data-quality history. Aggregate metrics only — no PHI.';
