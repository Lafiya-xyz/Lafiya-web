-- Outbox retry budgets, exponential backoff, and dead-letter state (issue #688).
--
-- The dispatcher previously retried a poison row on every poll forever.  This
-- migration makes retries bounded and observable:
--
--   • next_attempt_at gates when a pending row may be claimed again.
--   • last_error stores a short, PHI-redacted failure reason for operators.
--   • status = 'dead' is terminal after the per-event retry budget is spent.
--   • requeue_dead_outbox_row() is the only supported way out of 'dead'; every
--     requeue writes an immutable audit row (no payload is copied).
--
-- The retry schedule itself lives in lib/outbox/backoff.ts.  Postgres only
-- stores the resulting timestamp so multiple dispatcher instances agree on it.

-- ──────────────────────────────────────────────────────────────────────────
-- Retry state columns
-- ──────────────────────────────────────────────────────────────────────────

alter table public.outbox
  add column next_attempt_at timestamptz not null default now(),
  add column last_error      text,
  add column status          text        not null default 'pending',
  add column dead_at         timestamptz;

-- Backfill rows that were already delivered before this migration.
update public.outbox
  set status = 'dispatched'
  where dispatched_at is not null;

alter table public.outbox
  add constraint outbox_status_check
    check (status in ('pending', 'dispatched', 'dead')),
  add constraint outbox_last_error_length_check
    check (last_error is null or char_length(last_error) <= 500),
  add constraint outbox_dead_state_check
    check (
      (status = 'dead' and dead_at is not null)
      or (status <> 'dead' and dead_at is null)
    );

comment on column public.outbox.next_attempt_at is
  'Earliest time this pending row may be claimed again. The dispatcher applies '
  'capped exponential backoff with full jitter and stores the result here.';

comment on column public.outbox.last_error is
  'Sanitized, PHI-free reason for the most recent handler failure. Never '
  'contains payloads, identifiers, capability tokens, or provider secrets.';

comment on column public.outbox.status is
  'pending -> dispatched on success, or pending -> dead once the retry budget '
  'is exhausted. dead is terminal until an operator requeues the row.';

comment on column public.outbox.dead_at is
  'When the row entered the terminal dead state; null for pending/dispatched.';

-- Due-row scan: only pending work that is eligible now, oldest due first.
create index outbox_due_idx
  on public.outbox(next_attempt_at, created_at)
  where status = 'pending';

-- Operator/list queries for the dead-letter set.
create index outbox_dead_idx
  on public.outbox(dead_at desc)
  where status = 'dead';

-- ──────────────────────────────────────────────────────────────────────────
-- Dispatcher helpers
-- ──────────────────────────────────────────────────────────────────────────

-- Claim only rows whose retry time has arrived.  attempts is incremented once
-- per claimed delivery so the retry budget counts actual handler invocations.
create or replace function public.claim_outbox_batch(p_batch_size integer default 50)
returns setof public.outbox
language sql security definer set search_path = '' as $$
  update public.outbox
    set attempts = attempts + 1
  where id in (
    select id from public.outbox
    where status = 'pending'
      and next_attempt_at <= now()
    order by next_attempt_at, created_at
    limit greatest(p_batch_size, 0)
    for update skip locked
  )
  returning *;
$$;

revoke all on function public.claim_outbox_batch(integer) from public;
grant execute on function public.claim_outbox_batch(integer) to service_role;

-- Schedule a retry after a sanitized handler failure.  Only pending rows can be
-- deferred; a concurrent ack/dead-letter wins and this becomes a no-op.
create or replace function public.defer_outbox_row(
  p_id              uuid,
  p_next_attempt_at timestamptz,
  p_last_error      text
) returns void
language sql security definer set search_path = '' as $$
  update public.outbox
    set next_attempt_at = coalesce(p_next_attempt_at, now()),
        last_error      = left(p_last_error, 500)
  where id = p_id
    and status = 'pending';
$$;

revoke all on function public.defer_outbox_row(uuid, timestamptz, text) from public;
grant execute on function public.defer_outbox_row(uuid, timestamptz, text) to service_role;

-- Terminal transition after the retry budget is exhausted.
create or replace function public.dead_letter_outbox_row(
  p_id         uuid,
  p_last_error text
) returns void
language sql security definer set search_path = '' as $$
  update public.outbox
    set status      = 'dead',
        dead_at     = now(),
        last_error  = left(p_last_error, 500)
  where id = p_id
    and status = 'pending';
$$;

revoke all on function public.dead_letter_outbox_row(uuid, text) from public;
grant execute on function public.dead_letter_outbox_row(uuid, text) to service_role;

-- Mark a row dispatched (idempotent on duplicate calls).  Dead rows are never
-- acknowledged, so a handler that finishes after the budget was spent cannot
-- silently erase the dead-letter state.
create or replace function public.ack_outbox_row(p_id uuid)
returns void
language sql security definer set search_path = '' as $$
  update public.outbox
    set dispatched_at = now(),
        status        = 'dispatched',
        last_error    = null
  where id = p_id
    and status = 'pending';
$$;

revoke all on function public.ack_outbox_row(uuid) from public;
grant execute on function public.ack_outbox_row(uuid) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Operator requeue path with immutable audit trail
-- ──────────────────────────────────────────────────────────────────────────

create table public.outbox_requeue_audit (
  id                  uuid        primary key default gen_random_uuid(),
  outbox_id           uuid        not null,
  requeued_by         text        not null,
  reason              text        not null check (char_length(btrim(reason)) between 1 and 500),
  previous_status     text        not null check (previous_status = 'dead'),
  previous_attempts   integer     not null,
  previous_last_error text,
  requeued_at         timestamptz not null default now()
);

create index outbox_requeue_audit_outbox_idx
  on public.outbox_requeue_audit(outbox_id, requeued_at desc);

comment on table public.outbox_requeue_audit is
  'Immutable audit log for operator requeues of dead outbox rows (issue #688). '
  'Stores the reason, actor, and prior retry state only — never the payload.';

alter table public.outbox_requeue_audit enable row level security;

grant select on public.outbox_requeue_audit to service_role;

-- Requeue one dead row and record why/who.  Requires a non-empty reason and a
-- dead row; operators cannot use this to rewind in-flight pending rows.
create or replace function public.requeue_dead_outbox_row(
  p_id       uuid,
  p_reason   text,
  p_operator text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_row      public.outbox;
  v_operator text;
  v_reason   text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) = 0 or char_length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_REQUEUE_REASON';
  end if;

  select * into v_row
    from public.outbox
    where id = p_id
    for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'OUTBOX_ROW_NOT_FOUND';
  end if;

  if v_row.status <> 'dead' then
    raise exception using errcode = '22023', message = 'OUTBOX_ROW_NOT_DEAD';
  end if;

  v_operator := coalesce(
    nullif(btrim(coalesce(p_operator, '')), ''),
    nullif(auth.uid()::text, ''),
    current_user
  );

  insert into public.outbox_requeue_audit(
    outbox_id,
    requeued_by,
    reason,
    previous_status,
    previous_attempts,
    previous_last_error
  ) values (
    v_row.id,
    v_operator,
    v_reason,
    v_row.status,
    v_row.attempts,
    v_row.last_error
  );

  update public.outbox
    set status          = 'pending',
        dispatched_at   = null,
        dead_at         = null,
        attempts        = 0,
        last_error      = null,
        next_attempt_at = now()
  where id = v_row.id;
end;
$$;

revoke all on function public.requeue_dead_outbox_row(uuid, text, text) from public;
grant execute on function public.requeue_dead_outbox_row(uuid, text, text) to service_role;
