-- Migration to create the consent_logs table for compliance with NDPA (2023).
--
-- NOTE (issue #509): consent_logs is deprecated as a write target. The unified
-- consent ledger is public.consent_events (purpose-based, append-only), written
-- exclusively through public.record_consent() and read through
-- public.has_active_consent(). This table is retained as a read-only
-- compatibility surface for one release; a follow-up migration will drop it.
create table public.consent_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  policy_version text not null,
  accepted_at timestamptz not null default now(),
  constraint consent_logs_user_version_key unique (user_id, policy_version)
);

comment on table public.consent_logs is
  'DEPRECATED (issue #509): read-only compatibility view over the unified consent ledger (public.consent_events). Do not write directly; use public.record_consent().';

-- Enable Row Level Security
alter table public.consent_logs enable row level security;

-- Authenticated users can read their own consent logs
create policy "consent_logs_select_own"
on public.consent_logs for select
to authenticated
using (auth.uid() = user_id);

-- PostgREST grants (Supabase Data API needs this to expose the table to authenticated role)
grant select on public.consent_logs to authenticated;

-- ---------------------------------------------------------------------------
-- Issue #509: consolidate consent_logs into the unified consent ledger.
--
-- 1. Backfill: convert every consent_logs row into an append-only
--    consent_events row, preserving the original accepted_at timestamp and
--    policy_version. The backfill is idempotent: it is keyed on
--    (user_id, purpose, policy_version) and skips rows already present in the
--    ledger, so re-running the migration is a no-op.
-- 2. Compatibility view: replace the writable table with a read-only view so
--    existing readers keep working while all writes are redirected through
--    public.record_consent().
-- 3. Assertions: row-count and checksum checks fail the migration if the
--    backfill did not faithfully reproduce the source rows.
-- ---------------------------------------------------------------------------

-- 1. Idempotent backfill into the unified ledger.
--    consent_events is purpose-based; the legacy consent_logs table recorded a
--    single 'data_processing' purpose per policy_version, so we map it to that
--    purpose. ON CONFLICT keeps the operation idempotent.
insert into public.consent_events (user_id, purpose, policy_version, granted_at, granted)
select
  cl.user_id,
  'data_processing'::text as purpose,
  cl.policy_version,
  cl.accepted_at as granted_at,
  true as granted
from public.consent_logs cl
on conflict (user_id, purpose, policy_version) do nothing;

-- 2. Row-count assertion: every source row must have a matching ledger row.
do $$
declare
  source_count bigint;
  ledger_count bigint;
begin
  select count(*) into source_count from public.consent_logs;
  select count(*) into ledger_count
  from public.consent_events ce
  where ce.purpose = 'data_processing'
    and exists (
      select 1 from public.consent_logs cl
      where cl.user_id = ce.user_id
        and cl.policy_version = ce.policy_version
    );

  if ledger_count < source_count then
    raise exception
      'consent_logs backfill incomplete: source=%, ledger=%',
      source_count, ledger_count;
  end if;
end $$;

-- 3. Checksum assertion: the multiset of (user_id, policy_version, accepted_at)
--    must be identical between the source table and the ledger rows derived
--    from it. Any drift fails the migration.
do $$
declare
  source_checksum text;
  ledger_checksum text;
begin
  select md5(string_agg(
           cl.user_id::text || '|' || cl.policy_version || '|' || cl.accepted_at::text,
           ',' order by cl.user_id, cl.policy_version, cl.accepted_at
         ))
    into source_checksum
  from public.consent_logs cl;

  select md5(string_agg(
           ce.user_id::text || '|' || ce.policy_version || '|' || ce.granted_at::text,
           ',' order by ce.user_id, ce.policy_version, ce.granted_at
         ))
    into ledger_checksum
  from public.consent_events ce
  where ce.purpose = 'data_processing'
    and exists (
      select 1 from public.consent_logs cl
      where cl.user_id = ce.user_id
        and cl.policy_version = ce.policy_version
    );

  if source_checksum is distinct from ledger_checksum then
    raise exception
      'consent_logs backfill checksum mismatch: source=%, ledger=%',
      source_checksum, ledger_checksum;
  end if;
end $$;

-- 4. Replace the writable table with a read-only compatibility view so no
--    application code can write to consent_logs directly. The view exposes the
--    same columns as the legacy table, sourced from the unified ledger.
--    (The follow-up migration drops this view once callers are migrated.)
drop policy if exists "consent_logs_select_own" on public.consent_logs;
revoke all on public.consent_logs from authenticated;
drop table public.consent_logs;

create view public.consent_logs
with (security_invoker = true) as
select
  ce.id,
  ce.user_id,
  ce.policy_version,
  ce.granted_at as accepted_at
from public.consent_events ce
where ce.purpose = 'data_processing'
  and ce.granted;

comment on view public.consent_logs is
  'DEPRECATED (issue #509): read-only compatibility view over the unified consent ledger (public.consent_events). Do not write directly; use public.record_consent().';

grant select on public.consent_logs to authenticated;
