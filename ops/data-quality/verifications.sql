-- Issue #892: declarative data-quality expectations for verifications.
--
-- Counts and ratios over verification_intents / attestation_evidence /
-- trust_decisions. No record commitments, transaction hashes or CHW ids.

create or replace view public.data_quality_expectations as
select
  'verifications.daily_volume'::text as expectation_id,
  'verifications'::text as domain,
  'Verification intents issued in the last 24h.'::text as description,
  $sql$
    select count(*)::numeric
    from public.verification_intents
    where issued_at >= now() - interval '24 hours'
  $sql$::text as metric_sql,
  'upper'::text as direction,
  7 as min_samples,
  4::numeric as sensitivity
union all
select
  'verifications.expired_unsubmitted_ratio',
  'verifications',
  'Share of intents issued in the last 7d that expired without submission (0..1).',
  $sql$
    select coalesce(
      sum(case when submitted_at is null and expires_at < now() then 1 else 0 end)::numeric
        / nullif(count(*), 0),
      0)
    from public.verification_intents
    where issued_at >= now() - interval '7 days'
  $sql$,
  'upper',
  7,
  4::numeric
union all
select
  'verifications.unfinalized_evidence',
  'verifications',
  'Attestation evidence observed more than 1h ago and still not finalized.',
  $sql$
    select count(*)::numeric
    from public.attestation_evidence
    where finalized_at is null
      and invalidated_at is null
      and observed_at < now() - interval '1 hour'
  $sql$,
  'upper',
  7,
  3::numeric
union all
select
  'verifications.trusted_ratio',
  'verifications',
  'Share of trust decisions in the last 7d that are trusted (0..1).',
  $sql$
    select coalesce(
      sum(case when state = 'trusted' then 1 else 0 end)::numeric
        / nullif(count(*), 0),
      0)
    from public.trust_decisions
    where decided_at >= now() - interval '7 days'
  $sql$,
  'lower',
  7,
  4::numeric;
