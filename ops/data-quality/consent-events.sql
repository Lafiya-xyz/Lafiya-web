-- Issue #892: declarative data-quality expectations for consent events.
--
-- Aggregate counts only. No user ids, purposes per user, or timestamps of
-- individual consent decisions are exposed.

create or replace view public.data_quality_expectations as
select
  'consent_events.daily_volume'::text as expectation_id,
  'consent'::text as domain,
  'Consent events recorded in the last 24h (acknowledged + withdrawn).'::text as description,
  $sql$
    select count(*)::numeric
    from public.consent_events
    where occurred_at >= now() - interval '24 hours'
  $sql$::text as metric_sql,
  'upper'::text as direction,
  7 as min_samples,
  4::numeric as sensitivity
union all
select
  'consent_events.withdrawal_ratio',
  'consent',
  'Share of consent events in the last 7d that are withdrawals (0..1).',
  $sql$
    select coalesce(
      sum(case when action = 'withdrawn' then 1 else 0 end)::numeric
        / nullif(count(*), 0),
      0)
    from public.consent_events
    where occurred_at >= now() - interval '7 days'
  $sql$,
  'upper',
  7,
  4::numeric
union all
select
  'consent_events.orphaned_purposes',
  'consent',
  'Consent events whose purpose/version has no registered purpose row.',
  $sql$
    select count(*)::numeric
    from public.consent_events e
    where not exists (
      select 1 from public.consent_purposes p
      where p.purpose = e.purpose and p.version = e.purpose_version
    )
  $sql$,
  'upper',
  7,
  3::numeric;
