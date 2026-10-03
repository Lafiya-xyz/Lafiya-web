-- Issue #629: index attestation-contract admin events (WASM upgrades, admin
-- transfers, allowlist changes, pause) and persist a fail-safe trust state.
-- Written only by the governance monitor (service role); the public card
-- pages read the trust state through the service role as well.

alter table public.protocol_indexer_checkpoints
  drop constraint protocol_indexer_checkpoints_stream_check;
alter table public.protocol_indexer_checkpoints
  add constraint protocol_indexer_checkpoints_stream_check
  check (stream in ('attestations', 'payments', 'contract_admin'));

create table public.attestation_contract_admin_events (
  event_id text primary key,
  kind text not null check (
    kind in ('wasm_upgrade', 'admin_transfer', 'allowlist_change', 'pause', 'unpause')
  ),
  contract_id text not null,
  ledger_sequence bigint not null check (ledger_sequence > 0),
  transaction_hash text not null,
  wasm_hash text,
  subject text,
  action text check (action in ('added', 'removed')),
  observed_at timestamptz not null,
  indexed_at timestamptz not null default now()
);

create index attestation_contract_admin_events_kind_idx
  on public.attestation_contract_admin_events (kind, ledger_sequence desc);

-- Single-row table: the current trust state of the attestation contract.
create table public.attestation_contract_trust_state (
  singleton boolean primary key default true check (singleton),
  state text not null check (state in ('trusted', 'needs_review', 'paused')),
  wasm_hash text,
  reason_code text,
  updated_at timestamptz not null default now()
);

alter table public.attestation_contract_admin_events enable row level security;
alter table public.attestation_contract_trust_state enable row level security;

revoke all on public.attestation_contract_admin_events,
  public.attestation_contract_trust_state from anon, authenticated;
grant select, insert, update, delete on public.attestation_contract_admin_events,
  public.attestation_contract_trust_state to service_role;
