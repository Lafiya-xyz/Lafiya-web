-- Issue #787: audit trail for the operator CLI (lib/ops/cli.ts). Every
-- executed (non dry-run) command writes one row with the authenticated actor
-- and the mandatory reason.
create table public.operator_audit_log (
  id          uuid        primary key default gen_random_uuid(),
  actor_id    uuid        not null references auth.users(id),
  command     text        not null,
  args        jsonb       not null default '{}',
  reason      text        not null check (length(trim(reason)) > 0),
  environment text        not null,
  created_at  timestamptz not null default now()
);

create index operator_audit_log_created_at_idx
  on public.operator_audit_log(created_at desc);

-- RLS enabled with no policies: default-deny for anon/authenticated. Only the
-- service-role client used by the CLI can write; rows are append-only.
alter table public.operator_audit_log enable row level security;
revoke update, delete on public.operator_audit_log from anon, authenticated, service_role;
