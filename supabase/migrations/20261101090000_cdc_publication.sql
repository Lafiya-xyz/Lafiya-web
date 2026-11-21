-- Issue #889: change data capture over the public-card-content tables.
--
-- A long-running logical replication consumer (pgoutput) tails this
-- publication, maps committed row changes to cache-invalidation / outbox
-- events, and checkpoints its LSN. Everything the consumer needs to be
-- idempotent on replay from an older LSN lives here:
--
--   • cdc_publication          — the exact table set the consumer may read.
--   • cdc_consumer_checkpoints — last applied LSN per consumer (monotonic).
--   • cdc_apply_change()       — idempotent apply of one committed change.
--   • cdc_slot_health()        — slot lag metric for the readiness probe.
--   • cdc_shadow_compare()     — shadow-mode parity vs application events.
--
-- Privacy: the publication covers only tables whose rows are already
-- projected to the public card. The consumer never writes PHI into the
-- outbox — payloads carry opaque identifiers (card_public_id, revision id,
-- commitment) only.

-- ──────────────────────────────────────────────────────────────────────────
-- Publication
-- ──────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'cdc_publication') then
    create publication cdc_publication;
  end if;
end;
$$;

-- profiles: the compatibility snapshot read by get_emergency_card().
-- record_revisions: lifecycle state / disclosure policy / commitment.
-- trust_decisions: verified badge state.
-- consent_events: emergency_public_disclosure + offline_caching gates.
alter publication cdc_publication add table
  public.profiles,
  public.record_revisions,
  public.trust_decisions,
  public.consent_events;

comment on publication cdc_publication is
  'Issue #889: tables whose committed changes drive public-card cache '
  'invalidation and projections. Consumed by the logical replication '
  'consumer; contains no table that is not already projected publicly.';

-- ──────────────────────────────────────────────────────────────────────────
-- Checkpoints
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.cdc_consumer_checkpoints (
  consumer      text        primary key,
  slot_name     text        not null,
  last_lsn      pg_lsn      not null,
  last_txn_id   bigint,
  updated_at    timestamptz not null default now()
);

alter table public.cdc_consumer_checkpoints enable row level security;
revoke all on public.cdc_consumer_checkpoints from anon, authenticated;
grant select, insert, update on public.cdc_consumer_checkpoints to service_role;

comment on table public.cdc_consumer_checkpoints is
  'Issue #889: last applied LSN per CDC consumer. Replay from an older LSN '
  'is safe because cdc_apply_change() is idempotent.';

-- ──────────────────────────────────────────────────────────────────────────
-- Idempotent apply
-- ──────────────────────────────────────────────────────────────────────────

-- Maps one committed row change to a cache-invalidation event. Returns the
-- outbox row id, or null when the change is not cache-relevant (e.g. a
-- consent purpose unrelated to public disclosure).
--
-- Idempotency: the outbox row id is derived deterministically from
-- (consumer, lsn, table, key), so replaying the same change from an older
-- LSN inserts nothing new (on conflict do nothing) and returns the same id.
create or replace function public.cdc_apply_change(
  p_consumer   text,
  p_lsn        pg_lsn,
  p_table      text,
  p_op         text,
  p_key        text,
  p_card_id    uuid,
  p_commitment text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_event_type text;
  v_outbox_id  uuid;
begin
  if p_op not in ('insert', 'update', 'delete') then
    raise exception using errcode = '22023', message = 'INVALID_CDC_OP';
  end if;
  if p_table not in ('profiles', 'record_revisions', 'trust_decisions', 'consent_events') then
    raise exception using errcode = '22023', message = 'INVALID_CDC_TABLE';
  end if;

  v_event_type := case p_table
    when 'profiles'         then 'card_snapshot_changed'
    when 'record_revisions' then 'card_revision_changed'
    when 'trust_decisions'  then 'card_trust_changed'
    when 'consent_events'   then 'card_disclosure_changed'
  end;

  v_outbox_id := (
    substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4'
    || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3)
    || '-' || substr(v_hash, 21, 12)
  )::uuid;

  insert into public.outbox (id, aggregate, event_type, payload)
  values (
    v_outbox_id,
    'public_card',
    v_event_type,
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'cdc',
      'consumer', p_consumer,
      'lsn', p_lsn::text,
      'table', p_table,
      'op', p_op,
      'card_public_id', p_card_id,
      'commitment', p_commitment
    ))
  )
  on conflict (id) do nothing;

  -- Monotonic checkpoint: a replay from an older LSN never rewinds it.
  insert into public.cdc_consumer_checkpoints
    (consumer, slot_name, last_lsn, updated_at)
  values (p_consumer, p_consumer, p_lsn, now())
  on conflict (consumer) do update
    set last_lsn = greatest(public.cdc_consumer_checkpoints.last_lsn, excluded.last_lsn),
        updated_at = now();

  return v_outbox_id;
end;
$$;

revoke all on function public.cdc_apply_change(text, pg_lsn, text, text, text, uuid, text) from public;
grant execute on function public.cdc_apply_change(text, pg_lsn, text, text, text, uuid, text)
  to service_role;

comment on function public.cdc_apply_change(text, pg_lsn, text, text, text, uuid, text) is
  'Issue #889: idempotent apply of one committed CDC change. Deterministic '
  'outbox id makes replay from an older LSN a no-op.';

-- ──────────────────────────────────────────────────────────────────────────
-- Slot health
-- ──────────────────────────────────────────────────────────────────────────

-- Slot lag in bytes plus the checkpoint lag. Returns no row when the slot
-- does not exist yet (consumer never started) so the probe can distinguish
-- "not deployed" from "healthy".
create or replace function public.cdc_slot_health(p_slot_name text)
returns table (
  slot_name        text,
  active           boolean,
  lag_bytes        bigint,
  checkpoint_lag_bytes bigint,
  wal_status       text
)
language sql stable security definer set search_path = '' as $$
  select
    s.slot_name::text,
    s.active,
    greatest(pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn), 0)::bigint,
    greatest(
      pg_wal_lsn_diff(pg_current_wal_lsn(), coalesce(c.last_lsn, s.confirmed_flush_lsn)),
      0
    )::bigint,
    s.wal_status::text
  from pg_replication_slots s
  left join public.cdc_consumer_checkpoints c on c.slot_name = s.slot_name
  where s.slot_name = p_slot_name;
$$;

revoke all on function public.cdc_slot_health(text) from public;
grant execute on function public.cdc_slot_health(text) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Shadow-mode parity
-- ──────────────────────────────────────────────────────────────────────────

-- Compares CDC-emitted invalidation events against application-emitted ones
-- for the same window. `missing_in_cdc` are cards the application invalidated
-- but CDC did not; `missing_in_app` is the reverse. Both empty ⇒ parity.
create or replace function public.cdc_shadow_compare(
  p_since timestamptz,
  p_until timestamptz default now()
)
returns table (
  cdc_events      bigint,
  app_events      bigint,
  missing_in_cdc  bigint,
  missing_in_app  bigint
)
language sql stable security definer set search_path = '' as $$
  with cdc as (
    select distinct payload->>'card_public_id' as card_id
    from public.outbox
    where aggregate = 'public_card'
      and payload->>'source' = 'cdc'
      and created_at >= p_since and created_at < p_until
  ), app as (
    select distinct payload->>'card_public_id' as card_id
    from public.outbox
    where aggregate = 'public_card'
      and coalesce(payload->>'source', 'app') = 'app'
      and created_at >= p_since and created_at < p_until
  )
  select
    (select count(*) from cdc),
    (select count(*) from app),
    (select count(*) from app a where not exists (select 1 from cdc c where c.card_id = a.card_id)),
    (select count(*) from cdc c where not exists (select 1 from app a where a.card_id = c.card_id));
$$;

revoke all on function public.cdc_shadow_compare(timestamptz, timestamptz) from public;
grant execute on function public.cdc_shadow_compare(timestamptz, timestamptz) to service_role;
