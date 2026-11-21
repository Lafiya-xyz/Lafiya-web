-- Issue #892: declarative data-quality expectations for payouts.
--
-- Aggregate counts and USDC totals only. No recipient addresses, CHW ids or
-- transaction hashes are exposed by any metric.

create or replace view public.data_quality_expectations as
select
  'payouts.daily_settlement_count'::text as expectation_id,
  'payouts'::text as domain,
  'Payout settlements recorded in the last 24h.'::text as description,
  $sql$
    select count(*)::numeric
    from public.payout_settlements
    where settled_at >= now() - interval '24 hours'
  $sql$::text as metric_sql,
  'upper'::text as direction,
  7 as min_samples,
  4::numeric as sensitivity
union all
select
  'payouts.daily_settled_usdc',
  'payouts',
  'Total USDC settled in the last 24h.',
  $sql$
    select coalesce(sum(amount_usdc), 0)::numeric
    from public.payout_settlements
    where settled_at >= now() - interval '24 hours'
      and status = 'matched'
  $sql$,
  'upper',
  7,
  4::numeric
union all
select
  'payouts.quarantined_ratio',
  'payouts',
  'Share of settlements in the last 7d that are quarantined (0..1).',
  $sql$
    select coalesce(
      sum(case when status = 'quarantined' then 1 else 0 end)::numeric
        / nullif(count(*), 0),
      0)
    from public.payout_settlements
    where settled_at >= now() - interval '7 days'
  $sql$,
  'upper',
  7,
  4::numeric
union all
select
  'payouts.stale_pending_obligations',
  'payouts',
  'Pending payout obligations older than 24h.',
  $sql$
    select count(*)::numeric
    from public.payout_obligations
    where status = 'pending'
      and created_at < now() - interval '24 hours'
  $sql$,
  'upper',
  7,
  3::numeric;
