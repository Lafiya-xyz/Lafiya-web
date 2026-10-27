-- Issue #808: unified, read-only audit projection for the admin audit
-- explorer, plus an append-only log of every explorer query and its
-- justification (purpose-limited access).

create index if not exists consent_events_occurred_idx
  on public.consent_events (occurred_at desc);
create index if not exists break_glass_accesses_opened_idx
  on public.break_glass_accesses (opened_at desc);
create index if not exists attestation_contract_admin_events_observed_idx
  on public.attestation_contract_admin_events (observed_at desc);
-- card_access_events is range-partitioned on observed_at, so time-bounded
-- queries prune partitions; this adds per-partition subject lookup.
create index if not exists card_access_events_user_observed_idx
  on public.card_access_events (user_id, observed_at desc);

create or replace view public.audit_events
with (security_invoker = true) as
  select 'card_access'::text as source, id::text as event_id, observed_at as occurred_at,
         'system'::text as actor, user_id as subject_user_id,
         access_kind || ':' || outcome as action, capability_id::text as correlation_id,
         jsonb_build_object('capability_id', capability_id) as detail
    from public.card_access_events
  union all
  select 'consent', id::text, occurred_at, 'patient', user_id,
         action, idempotency_key::text,
         jsonb_build_object('purpose', purpose, 'purpose_version', purpose_version)
    from public.consent_events
  union all
  select 'break_glass', id::text, opened_at, clinician_id::text, patient_user_id,
         'break_glass_open', revision_id::text,
         jsonb_build_object('reason', reason, 'fields_disclosed', fields_disclosed,
                            'expires_at', expires_at)
    from public.break_glass_accesses
  union all
  select 'contract_admin', event_id, observed_at, coalesce(subject, 'contract'), null::uuid,
         kind, transaction_hash,
         jsonb_build_object('contract_id', contract_id, 'ledger_sequence', ledger_sequence,
                            'wasm_hash', wasm_hash, 'action', action)
    from public.attestation_contract_admin_events;

revoke all on public.audit_events from anon, authenticated;

create table if not exists public.audit_explorer_queries (
  id uuid primary key default gen_random_uuid(),
  admin_id text not null,
  admin_role text not null,
  justification text not null check (char_length(justification) between 10 and 500),
  filters jsonb not null,
  result_count integer not null,
  exported_format text check (exported_format in ('csv', 'json')),
  queried_at timestamptz not null default now()
);

alter table public.audit_explorer_queries enable row level security;

create or replace function public.audit_explorer_queries_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_explorer_queries is append-only';
end;
$$;

drop trigger if exists audit_explorer_queries_no_mutation on public.audit_explorer_queries;
create trigger audit_explorer_queries_no_mutation
  before update or delete on public.audit_explorer_queries
  for each row execute function public.audit_explorer_queries_append_only();
