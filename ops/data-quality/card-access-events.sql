-- Issue #892: declarative data-quality expectations for card access events.
--
-- card_access_events is intentionally non-identifying (no capability token,
-- IP, user agent or record id), so every metric here is a plain count/ratio.

create or replace view public.data_quality_expectations as
select
  'card_access_events.daily_volume'::text as expectation_id,
  'card_access'::text as domain,
  'Card access events observed in the last 24h.'::text as description,
  $sql$
    select count(*)::numeric
    from public.card_access_events
    where observed_at >= now() - interval '24 hours'
  $sql$::text as metric_sql,
  'upper'::text as direction,
  7 as min_samples,
  4::numeric as sensitivity
union all
select
  'card_access_events.inactive_ratio',
  'card_access',
  'Share of card access attempts in the last 24h that were inactive (0..1).',
  $sql$
    select coalesce(
      sum(case when outcome = 'inactive' then 1 else 0 end)::numeric
        / nullif(count(*), 0),
      0)
    from public.card_access_events
    where observed_at >= now() - interval '24 hours'
  $sql$,
  'upper',
  7,
  4::numeric
union all
select
  'card_access_events.orphaned_capabilities',
  'card_access',
  'Capability-kind access events whose capability row no longer exists.',
  $sql$
    select count(*)::numeric
    from public.card_access_events e
    where e.access_kind = 'capability'
      and e.capability_id is not null
      and not exists (
        select 1 from public.emergency_capabilities c where c.id = e.capability_id
      )
  $sql$,
  'upper',
  7,
  3::numeric;
