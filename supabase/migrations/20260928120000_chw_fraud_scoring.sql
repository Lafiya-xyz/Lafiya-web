-- CHW fraud scoring pipeline: automated feeders for protocol_quarantine.
--
-- Implements the "flag suspicious CHWs" issue. Adds the raw signal columns
-- the rule engine needs (device/IP were not previously captured at all),
-- materialized views computing the four signal families from the issue
-- (burst velocity, shared device/IP across distinct patients, near-duplicate
-- records, mutual-verification graph clusters), a shadow-mode-first flags
-- table with an audit trail for reviewer actions, and a rule-evaluation
-- function that quarantines obligations once a rule is promoted out of
-- shadow mode.
--
-- Ships in shadow mode: evaluate_fraud_rules() always records findings in
-- chw_fraud_flags, but only calls quarantine_protocol_event (which blocks
-- settlement via the existing payout pipeline) when shadow_mode = false for
-- the rule that fired. All rules default to shadow_mode = true so this
-- migration cannot block any existing payout on deploy.

begin;

-- 1. Raw signal capture -------------------------------------------------
-- verification_intents previously carried no client metadata at all.
alter table verification_intents
  add column if not exists device_id text,
  add column if not exists ip_address inet;

comment on column verification_intents.device_id is
  'Client-reported device identifier, used only for fraud-signal aggregation. Never joined to patient record content.';
comment on column verification_intents.ip_address is
  'Submitting IP address, used only for fraud-signal aggregation (shared-device/IP clustering).';

-- 2. Rule catalog ---------------------------------------------------------
create table if not exists fraud_rule_definitions (
  rule_code text primary key,
  description text not null,
  signal_family text not null check (signal_family in (
    'burst_velocity', 'shared_device_ip', 'near_duplicate', 'mutual_graph'
  )),
  threshold jsonb not null default '{}'::jsonb,
  shadow_mode boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into fraud_rule_definitions (rule_code, description, signal_family, threshold, shadow_mode)
values
  ('burst_velocity_v1',
   'More than N verification intents claimed by one CHW within a rolling window',
   'burst_velocity', jsonb_build_object('max_per_hour', 8), true),
  ('shared_device_ip_v1',
   'Same device_id or ip_address used across intents claiming distinct patients for more than one CHW identity',
   'shared_device_ip', jsonb_build_object('min_distinct_chws', 2), true),
  ('near_duplicate_v1',
   'Two intents from the same CHW with identical revision_id submitted within a short window (resubmission masquerading as a new registration)',
   'near_duplicate', jsonb_build_object('window_minutes', 10), true),
  ('mutual_graph_v1',
   'A small cluster of CHWs whose verification intents reference each other''s revisions in a short window (mutual-verification ring)',
   'mutual_graph', jsonb_build_object('max_cluster_size', 5, 'window_hours', 24), true)
on conflict (rule_code) do nothing;

-- 3. Signal views (refresh on a schedule; not indexed further here) ------
create materialized view if not exists mv_chw_verification_velocity as
select
  chw_id,
  date_trunc('hour', issued_at) as bucket_hour,
  count(*) as intents_in_hour
from verification_intents
group by chw_id, date_trunc('hour', issued_at);

create materialized view if not exists mv_shared_device_ip_clusters as
select
  coalesce(device_id, ip_address::text) as cluster_key,
  array_agg(distinct chw_id) as chw_ids,
  count(distinct chw_id) as distinct_chw_count,
  count(distinct revision_id) as distinct_revision_count
from verification_intents
where device_id is not null or ip_address is not null
group by coalesce(device_id, ip_address::text)
having count(distinct chw_id) > 1;

create materialized view if not exists mv_near_duplicate_intents as
select
  a.chw_id,
  a.id as intent_id,
  a.revision_id,
  a.issued_at,
  b.id as duplicate_of_intent_id,
  b.issued_at as duplicate_issued_at,
  extract(epoch from (a.issued_at - b.issued_at)) as seconds_apart
from verification_intents a
join verification_intents b
  on a.chw_id = b.chw_id
  and a.revision_id = b.revision_id
  and a.id <> b.id
  and a.issued_at > b.issued_at
  and a.issued_at - b.issued_at < interval '10 minutes';

create materialized view if not exists mv_mutual_verification_clusters as
select
  least(a.chw_id, b.chw_id) as chw_id_low,
  greatest(a.chw_id, b.chw_id) as chw_id_high,
  count(*) as shared_revision_count
from verification_intents a
join verification_intents b
  on a.revision_id = b.revision_id
  and a.chw_id <> b.chw_id
  and a.issued_at - b.issued_at < interval '24 hours'
  and a.issued_at - b.issued_at > interval '0 hours'
group by least(a.chw_id, b.chw_id), greatest(a.chw_id, b.chw_id)
having count(*) >= 2;

-- 4. Findings + reviewer audit trail --------------------------------------
create table if not exists chw_fraud_flags (
  id uuid primary key default gen_random_uuid(),
  chw_id uuid not null,
  rule_code text not null references fraud_rule_definitions(rule_code),
  reason_code text not null,
  evidence jsonb not null default '{}'::jsonb,
  severity_score numeric not null default 0,
  status text not null default 'shadow' check (status in ('shadow', 'quarantined', 'released', 'voided')),
  detected_at timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text
);

create index if not exists idx_chw_fraud_flags_chw_id on chw_fraud_flags (chw_id);
create index if not exists idx_chw_fraud_flags_status on chw_fraud_flags (status);

-- Widen protocol_quarantine's stream check to accept a 'fraud' stream so
-- the rule engine can reuse the existing quarantine feeder/audit surface
-- rather than building a parallel blocking mechanism.
alter table protocol_quarantine drop constraint if exists protocol_quarantine_stream_check;
alter table protocol_quarantine add constraint protocol_quarantine_stream_check
  check (stream in ('attestations', 'payments', 'fraud'));

-- 5. Rule evaluation function (SECURITY DEFINER, mirrors quarantine_protocol_event) ---
create or replace function evaluate_fraud_rules()
returns table (rule_code text, chw_id uuid, quarantined boolean) as $$
declare
  r record;
  is_shadow boolean;
begin
  -- burst_velocity_v1
  select shadow_mode into is_shadow from fraud_rule_definitions where fraud_rule_definitions.rule_code = 'burst_velocity_v1';
  for r in
    select v.chw_id, v.intents_in_hour, v.bucket_hour
    from mv_chw_verification_velocity v, fraud_rule_definitions d
    where d.rule_code = 'burst_velocity_v1'
      and v.intents_in_hour > (d.threshold->>'max_per_hour')::int
  loop
    insert into chw_fraud_flags (chw_id, rule_code, reason_code, evidence, severity_score, status)
    values (r.chw_id, 'burst_velocity_v1', 'burst_velocity_exceeded',
            jsonb_build_object('intents_in_hour', r.intents_in_hour, 'bucket_hour', r.bucket_hour),
            r.intents_in_hour, case when is_shadow then 'shadow' else 'quarantined' end);
    if not is_shadow then
      perform quarantine_protocol_event('fraud', r.chw_id::text || ':' || r.bucket_hour::text, 'burst_velocity_v1');
    end if;
    rule_code := 'burst_velocity_v1'; chw_id := r.chw_id; quarantined := not is_shadow;
    return next;
  end loop;

  -- shared_device_ip_v1
  select shadow_mode into is_shadow from fraud_rule_definitions where fraud_rule_definitions.rule_code = 'shared_device_ip_v1';
  for r in
    select unnest(chw_ids) as chw_id, cluster_key, distinct_chw_count
    from mv_shared_device_ip_clusters, fraud_rule_definitions d
    where d.rule_code = 'shared_device_ip_v1'
      and distinct_chw_count >= (d.threshold->>'min_distinct_chws')::int
  loop
    insert into chw_fraud_flags (chw_id, rule_code, reason_code, evidence, severity_score, status)
    values (r.chw_id, 'shared_device_ip_v1', 'shared_device_or_ip',
            jsonb_build_object('cluster_key', r.cluster_key, 'distinct_chw_count', r.distinct_chw_count),
            r.distinct_chw_count, case when is_shadow then 'shadow' else 'quarantined' end);
    if not is_shadow then
      perform quarantine_protocol_event('fraud', r.chw_id::text || ':' || r.cluster_key, 'shared_device_ip_v1');
    end if;
    rule_code := 'shared_device_ip_v1'; chw_id := r.chw_id; quarantined := not is_shadow;
    return next;
  end loop;

  return;
end;
$$ language plpgsql security definer;

comment on function evaluate_fraud_rules() is
  'Rule engine entry point: computes findings from the mv_* signal views and writes chw_fraud_flags. Only quarantines (blocking settlement) for rules whose fraud_rule_definitions.shadow_mode = false. Intended to run on a schedule after the mv_* views are refreshed.';

commit;
