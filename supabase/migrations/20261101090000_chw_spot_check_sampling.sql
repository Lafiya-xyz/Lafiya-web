-- Issue #911: supervisor spot-check sampling with random re-verification.
--
-- Adds:
--   1. a `supervisor` role on chw_identities (a CHW who may review peers),
--   2. a reproducible, risk-stratified spot-check sampler
--      (sample_spot_checks()) that draws a deterministic, auditable sample of
--      settled attestations per CHW using a caller-supplied seed,
--   3. per-field match/mismatch outcome recording (record_spot_check_outcome())
--      that feeds fraud scoring and, on mismatch, holds the CHW's pending
--      payouts via the existing protocol_quarantine feeder,
--   4. a k-anonymity-respecting QA view (chw_spot_check_qa) of per-CHW
--      mismatch rates.
--
-- Privacy: spot checks reference verification_intents / attestation_evidence
-- (protocol metadata) and per-field *outcomes* only. No patient health record
-- content is copied into these tables; a supervisor re-verifies in the field
-- and records match/mismatch per field name.

begin;

-- 1. Supervisor role ------------------------------------------------------
alter table public.chw_identities
  add column if not exists is_supervisor boolean not null default false;

comment on column public.chw_identities.is_supervisor is
  'Issue #911: CHW may act as a spot-check supervisor (sample peers, record outcomes, read QA metrics).';

-- 2. Spot-check sample + outcome tables -----------------------------------
create table if not exists public.chw_spot_checks (
  id uuid primary key default gen_random_uuid(),
  -- Reproducibility: (seed, chw_id, intent_id) is the sampling identity, so
  -- re-running the sampler with the same seed never duplicates a draw.
  seed text not null check (char_length(seed) between 1 and 128),
  chw_id uuid not null references public.chw_identities (chw_id) on delete cascade,
  intent_id uuid not null references public.verification_intents (id) on delete cascade,
  evidence_id uuid references public.attestation_evidence (id) on delete set null,
  risk_stratum text not null check (risk_stratum in ('high', 'medium', 'low')),
  -- Deterministic uniform draw in [0,1) derived from hash(seed, intent_id).
  draw numeric not null check (draw >= 0 and draw < 1),
  sampled_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'passed', 'failed', 'voided')),
  supervisor_id uuid references public.chw_identities (chw_id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  unique (seed, intent_id)
);

create index if not exists idx_chw_spot_checks_chw on public.chw_spot_checks (chw_id, status);
create index if not exists idx_chw_spot_checks_status on public.chw_spot_checks (status);

create table if not exists public.chw_spot_check_fields (
  id uuid primary key default gen_random_uuid(),
  spot_check_id uuid not null references public.chw_spot_checks (id) on delete cascade,
  field_name text not null check (field_name ~ '^[a-z0-9_]{1,64}$'),
  outcome text not null check (outcome in ('match', 'mismatch', 'not_checked')),
  recorded_at timestamptz not null default now(),
  unique (spot_check_id, field_name)
);

alter table public.chw_spot_checks enable row level security;
alter table public.chw_spot_check_fields enable row level security;

revoke all on public.chw_spot_checks from anon, authenticated;
revoke all on public.chw_spot_check_fields from anon, authenticated;
grant select, insert, update, delete on public.chw_spot_checks to service_role;
grant select, insert, update, delete on public.chw_spot_check_fields to service_role;

-- 3. Reproducible, risk-stratified sampler --------------------------------
-- Risk strata (per CHW, over the last 30 days of settled attestations):
--   high   -- CHW has an open fraud flag or a prior failed spot check,
--   medium -- CHW has any prior spot check history,
--   low    -- everyone else.
-- Sampling rate per stratum is data, not code (spot_check_policy).
create table if not exists public.spot_check_policy (
  risk_stratum text primary key check (risk_stratum in ('high', 'medium', 'low')),
  sample_rate numeric not null check (sample_rate > 0 and sample_rate <= 1),
  updated_at timestamptz not null default now()
);

insert into public.spot_check_policy (risk_stratum, sample_rate)
values ('high', 0.5), ('medium', 0.2), ('low', 0.05)
on conflict (risk_stratum) do nothing;

create or replace function public.sample_spot_checks(
  p_seed text,
  p_since timestamptz default now() - interval '30 days'
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
begin
  if p_seed is null or char_length(p_seed) < 1 then
    raise exception using errcode = '22023', message = 'INVALID_SEED';
  end if;

  with candidates as (
    select
      i.chw_id,
      i.id as intent_id,
      e.id as evidence_id,
      case
        when exists (
          select 1 from public.chw_fraud_flags f
           where f.chw_id = i.chw_id and f.status = 'quarantined'
        ) or exists (
          select 1 from public.chw_spot_checks s
           where s.chw_id = i.chw_id and s.status = 'failed'
        ) then 'high'
        when exists (
          select 1 from public.chw_spot_checks s where s.chw_id = i.chw_id
        ) then 'medium'
        else 'low'
      end as risk_stratum,
      -- Deterministic uniform draw: same seed + intent always yields the same
      -- value, so the sample is reproducible and independently auditable.
      (('x' || substr(encode(extensions.digest(p_seed || ':' || i.id::text, 'sha256'), 'hex'), 1, 8))::bit(32)::bigint
        + 2147483648)::numeric / 4294967296::numeric as draw
    from public.verification_intents i
    join public.attestation_evidence e on e.intent_id = i.id
    where e.finalized_at is not null
      and e.invalidated_at is null
      and i.issued_at >= p_since
  ),
  selected as (
    select c.*
    from candidates c
    join public.spot_check_policy p on p.risk_stratum = c.risk_stratum
    where c.draw < p.sample_rate
  )
  insert into public.chw_spot_checks (seed, chw_id, intent_id, evidence_id, risk_stratum, draw)
  select p_seed, s.chw_id, s.intent_id, s.evidence_id, s.risk_stratum, s.draw
  from selected s
  on conflict (seed, intent_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.sample_spot_checks(text, timestamptz) is
  'Issue #911: reproducible risk-stratified spot-check sampler. Same seed + window always selects the same intents (draw = hash(seed:intent_id)); re-runs are idempotent via unique(seed, intent_id).';

-- 4. Outcome recording -> fraud scoring + payout holds --------------------
create or replace function public.record_spot_check_outcome(
  p_spot_check_id uuid,
  p_supervisor_id uuid,
  p_fields jsonb,
  p_note text default null
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_check public.chw_spot_checks;
  v_mismatches integer;
  v_status text;
begin
  select * into v_check from public.chw_spot_checks where id = p_spot_check_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'SPOT_CHECK_NOT_FOUND';
  end if;
  if v_check.status <> 'pending' then
    raise exception using errcode = '22023', message = 'SPOT_CHECK_ALREADY_REVIEWED';
  end if;
  if not exists (
    select 1 from public.chw_identities c
     where c.chw_id = p_supervisor_id and c.is_supervisor and c.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'NOT_A_SUPERVISOR';
  end if;
  if p_supervisor_id = v_check.chw_id then
    raise exception using errcode = '42501', message = 'SELF_REVIEW_FORBIDDEN';
  end if;

  insert into public.chw_spot_check_fields (spot_check_id, field_name, outcome)
  select p_spot_check_id, f->>'field_name', f->>'outcome'
  from jsonb_array_elements(p_fields) f
  on conflict (spot_check_id, field_name) do update set outcome = excluded.outcome;

  select count(*) into v_mismatches
  from public.chw_spot_check_fields
  where spot_check_id = p_spot_check_id and outcome = 'mismatch';

  v_status := case when v_mismatches > 0 then 'failed' else 'passed' end;

  update public.chw_spot_checks
     set status = v_status,
         supervisor_id = p_supervisor_id,
         reviewed_at = now(),
         review_note = p_note
   where id = p_spot_check_id;

  if v_mismatches > 0 then
    -- Feed fraud scoring: a failed spot check is a first-class finding.
    insert into public.chw_fraud_flags (chw_id, rule_code, reason_code, evidence, severity_score, status)
    values (
      v_check.chw_id,
      'spot_check_mismatch_v1',
      'spot_check_mismatch',
      jsonb_build_object(
        'spot_check_id', p_spot_check_id,
        'intent_id', v_check.intent_id,
        'mismatched_fields', v_mismatches,
        'risk_stratum', v_check.risk_stratum
      ),
      v_mismatches,
      'quarantined'
    );

    -- Hold payouts: reuse the existing quarantine feeder so the payout
    -- pipeline blocks settlement for this CHW's pending obligations.
    perform public.quarantine_protocol_event(
      'fraud',
      v_check.chw_id::text || ':spot_check:' || p_spot_check_id::text,
      'spot_check_mismatch'
    );

    update public.payout_obligations
       set status = 'quarantined', adjustment_reason = 'spot_check_mismatch'
     where chw_id = v_check.chw_id and status = 'pending';
  end if;

  return v_status;
end;
$$;

comment on function public.record_spot_check_outcome(uuid, uuid, jsonb, text) is
  'Issue #911: records per-field match/mismatch outcomes. Any mismatch writes a chw_fraud_flags row, quarantines the CHW via quarantine_protocol_event and holds pending payout obligations.';

-- Register the new rule in the catalog (shadow_mode = false: a human
-- supervisor confirmed the mismatch, so it blocks settlement immediately).
insert into public.fraud_rule_definitions (rule_code, description, signal_family, threshold, shadow_mode)
values (
  'spot_check_mismatch_v1',
  'A supervisor spot-check re-verification found at least one mismatched field',
  'spot_check', jsonb_build_object('k_min_spot_checks', 5), false
)
on conflict (rule_code) do nothing;

alter table public.fraud_rule_definitions drop constraint if exists fraud_rule_definitions_signal_family_check;
alter table public.fraud_rule_definitions add constraint fraud_rule_definitions_signal_family_check
  check (signal_family in ('burst_velocity', 'shared_device_ip', 'near_duplicate', 'mutual_graph', 'spot_check'));

-- 5. k-anonymity-respecting QA metrics ------------------------------------
-- Per-CHW mismatch rates are only exposed when the CHW has at least
-- k_min_spot_checks reviewed spot checks; below that the row is suppressed
-- (chw_id null, counts null) so a single check cannot identify a CHW.
create or replace view public.chw_spot_check_qa as
with per_chw as (
  select
    s.chw_id,
    count(*) filter (where s.status in ('passed', 'failed')) as reviewed_checks,
    count(*) filter (where s.status = 'failed') as failed_checks,
    count(*) filter (where s.status = 'pending') as pending_checks
  from public.chw_spot_checks s
  group by s.chw_id
),
k as (
  select coalesce(
    (select (threshold->>'k_min_spot_checks')::int
       from public.fraud_rule_definitions
      where rule_code = 'spot_check_mismatch_v1'),
    5
  ) as k_min
)
select
  case when p.reviewed_checks >= k.k_min then p.chw_id end as chw_id,
  case when p.reviewed_checks >= k.k_min then p.reviewed_checks end as reviewed_checks,
  case when p.reviewed_checks >= k.k_min then p.failed_checks end as failed_checks,
  case when p.reviewed_checks >= k.k_min
       then round(p.failed_checks::numeric / nullif(p.reviewed_checks, 0), 4) end as mismatch_rate,
  p.pending_checks,
  p.reviewed_checks >= k.k_min as meets_k_anonymity
from per_chw p
cross join k;

comment on view public.chw_spot_check_qa is
  'Issue #911: per-CHW spot-check mismatch rates, suppressed below k_min_spot_checks reviewed checks (k-anonymity).';

revoke all on public.chw_spot_check_qa from anon, authenticated;
grant select on public.chw_spot_check_qa to service_role;

revoke all on function public.sample_spot_checks(text, timestamptz) from public, anon, authenticated;
revoke all on function public.record_spot_check_outcome(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.sample_spot_checks(text, timestamptz) to service_role;
grant execute on function public.record_spot_check_outcome(uuid, uuid, jsonb, text) to service_role;

commit;
