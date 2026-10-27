-- Issue #806: immutable FX rate snapshots with provenance for fiat-equivalent
-- reporting. Rows are insert-only; reports reference snapshot_id so a
-- historical report recomputes from the stored rate, never the live one.
create table if not exists public.fx_rate_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  source text not null,
  pair text not null check (pair ~ '^[A-Z]{3,5}/[A-Z]{3,5}$'),
  -- Decimal string, 7 dp; numeric keeps exact precision.
  rate numeric(20, 7) not null check (rate > 0),
  observed_at timestamptz not null,
  period text check (period is null or period ~ '^\d{4}-\d{2}$'),
  indicative boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists fx_rate_snapshots_pair_observed_idx
  on public.fx_rate_snapshots (pair, observed_at desc);
create unique index if not exists fx_rate_snapshots_pair_period_idx
  on public.fx_rate_snapshots (pair, period) where period is not null;

alter table public.fx_rate_snapshots enable row level security;

create or replace function public.fx_rate_snapshots_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'fx_rate_snapshots rows are immutable';
end;
$$;

drop trigger if exists fx_rate_snapshots_no_update on public.fx_rate_snapshots;
create trigger fx_rate_snapshots_no_update
  before update or delete on public.fx_rate_snapshots
  for each row execute function public.fx_rate_snapshots_immutable();
