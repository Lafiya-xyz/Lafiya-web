-- Issue #908: governed payout recovery (clawback / offset / write-off).
--
-- A fraudulent payout becomes a receivable: a debt ledger entry linked to the
-- original payout obligation. Future payouts are auto-offset against open
-- receivables up to a configurable percentage, on-chain repayments are matched
-- by memo reference, and write-offs require two-person approval. Every state
-- change is appended to an immutable audit table.
--
-- Ledger invariants (enforced by constraints + the functions below):
--   I1. recovered_usdc + written_off_usdc + outstanding_usdc = original_usdc
--       for every receivable, at all times.
--   I2. sum(offset entries) = recovered_usdc for every receivable.
--   I3. an offset never exceeds the obligation amount nor the receivable's
--       outstanding balance.
--   I4. a receivable is 'open' iff outstanding_usdc > 0.
--   I5. write-offs need two distinct approvers and are terminal.
--
-- All tables are service-role only; no patient data is referenced.

create type public.payout_receivable_status as enum (
  'open', 'recovered', 'written_off'
);

create table public.payout_recovery_config (
  id boolean primary key default true check (id),
  -- Percentage of each future payout that may be withheld, 0..100.
  max_offset_percent numeric(5, 2) not null default 25
    check (max_offset_percent >= 0 and max_offset_percent <= 100),
  updated_at timestamptz not null default now()
);
insert into public.payout_recovery_config (id) values (true) on conflict do nothing;

create table public.payout_receivables (
  id uuid primary key default gen_random_uuid(),
  -- The fraudulent payout this receivable recovers.
  obligation_id uuid not null unique
    references public.payout_obligations(id) on delete restrict,
  chw_id uuid not null references public.chw_identities(chw_id) on delete restrict,
  recipient_address text not null check (recipient_address ~ '^G[A-Z2-7]{55}$'),
  original_usdc numeric(20, 7) not null check (original_usdc > 0),
  recovered_usdc numeric(20, 7) not null default 0 check (recovered_usdc >= 0),
  written_off_usdc numeric(20, 7) not null default 0 check (written_off_usdc >= 0),
  outstanding_usdc numeric(20, 7) not null check (outstanding_usdc >= 0),
  status public.payout_receivable_status not null default 'open',
  reason_code text not null,
  opened_by uuid not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint payout_receivables_balance check (
    recovered_usdc + written_off_usdc + outstanding_usdc = original_usdc
  ),
  constraint payout_receivables_status_balance check (
    (status = 'open' and outstanding_usdc > 0)
    or (status <> 'open' and outstanding_usdc = 0)
  )
);
create index payout_receivables_open_idx
  on public.payout_receivables (chw_id, opened_at)
  where status = 'open';

-- Append-only ledger of recovery movements. `offset` rows are withheld from a
-- future payout; `repayment` rows are CHW-initiated on-chain repayments.
create table public.payout_recovery_entries (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null
    references public.payout_receivables(id) on delete restrict,
  kind text not null check (kind in ('offset', 'repayment')),
  amount_usdc numeric(20, 7) not null check (amount_usdc > 0),
  -- For offsets: the obligation the amount was withheld from.
  offset_obligation_id uuid
    references public.payout_obligations(id) on delete restrict,
  -- For repayments: the on-chain transaction hash (unique => idempotent).
  repayment_tx_hash text,
  memo_reference text,
  created_at timestamptz not null default now(),
  constraint payout_recovery_entries_kind_shape check (
    (kind = 'offset' and offset_obligation_id is not null and repayment_tx_hash is null)
    or (kind = 'repayment' and repayment_tx_hash is not null and offset_obligation_id is null)
  )
);
create unique index payout_recovery_entries_repayment_unique
  on public.payout_recovery_entries (repayment_tx_hash)
  where repayment_tx_hash is not null;
create unique index payout_recovery_entries_offset_unique
  on public.payout_recovery_entries (receivable_id, offset_obligation_id)
  where offset_obligation_id is not null;

create table public.payout_writeoff_requests (
  id uuid primary key default gen_random_uuid(),
  receivable_id uuid not null
    references public.payout_receivables(id) on delete restrict,
  amount_usdc numeric(20, 7) not null check (amount_usdc > 0),
  reason_code text not null,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  first_approver uuid,
  first_approved_at timestamptz,
  second_approver uuid,
  second_approved_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  constraint payout_writeoff_two_person check (
    first_approver is null or second_approver is null
    or first_approver <> second_approver
  ),
  constraint payout_writeoff_requester_not_approver check (
    (first_approver is null or first_approver <> requested_by)
    and (second_approver is null or second_approver <> requested_by)
  )
);
create unique index payout_writeoff_requests_pending_unique
  on public.payout_writeoff_requests (receivable_id)
  where status = 'pending';

create table public.payout_recovery_audit (
  id bigint generated always as identity primary key,
  receivable_id uuid not null,
  action text not null check (action in (
    'opened', 'offset', 'repayment', 'writeoff_requested',
    'writeoff_approved', 'writeoff_rejected', 'writeoff_applied'
  )),
  actor_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index payout_recovery_audit_receivable_idx
  on public.payout_recovery_audit (receivable_id, created_at);

alter table public.payout_recovery_config enable row level security;
alter table public.payout_receivables enable row level security;
alter table public.payout_recovery_entries enable row level security;
alter table public.payout_writeoff_requests enable row level security;
alter table public.payout_recovery_audit enable row level security;

revoke all on public.payout_recovery_config, public.payout_receivables,
  public.payout_recovery_entries, public.payout_writeoff_requests,
  public.payout_recovery_audit from anon, authenticated;
grant select, insert, update, delete on public.payout_recovery_config,
  public.payout_receivables, public.payout_recovery_entries,
  public.payout_writeoff_requests to service_role;
grant select, insert on public.payout_recovery_audit to service_role;

-- Audit rows are append-only even for the service role.
create function public.payout_recovery_audit_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = 'PAYOUT_RECOVERY_AUDIT_IMMUTABLE';
end;
$$;
create trigger payout_recovery_audit_no_update
  before update or delete on public.payout_recovery_audit
  for each row execute function public.payout_recovery_audit_immutable();

-- Opens a receivable against a settled payout obligation.
create function public.open_payout_receivable(
  p_obligation_id uuid,
  p_reason_code text,
  p_actor_id uuid
) returns public.payout_receivables
language plpgsql security definer set search_path = '' as $$
declare v_obligation public.payout_obligations; v_row public.payout_receivables;
begin
  select * into v_obligation from public.payout_obligations
    where id = p_obligation_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'OBLIGATION_NOT_FOUND';
  end if;
  if v_obligation.status <> 'settled' then
    raise exception using errcode = '22023', message = 'OBLIGATION_NOT_SETTLED';
  end if;
  if v_obligation.amount_usdc <= 0 then
    raise exception using errcode = '22023', message = 'OBLIGATION_ZERO_AMOUNT';
  end if;

  insert into public.payout_receivables (
    obligation_id, chw_id, recipient_address, original_usdc,
    outstanding_usdc, reason_code, opened_by
  ) values (
    v_obligation.id, v_obligation.chw_id, v_obligation.recipient_address,
    v_obligation.amount_usdc, v_obligation.amount_usdc, p_reason_code, p_actor_id
  )
  on conflict (obligation_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.payout_receivables
      where obligation_id = p_obligation_id;
    return v_row;
  end if;

  insert into public.payout_recovery_audit (receivable_id, action, actor_id, detail)
    values (v_row.id, 'opened', p_actor_id,
      jsonb_build_object('original_usdc', v_row.original_usdc, 'reason_code', p_reason_code));
  return v_row;
end;
$$;

-- Computes how much of `p_amount_usdc` may be withheld for `p_chw_id` under the
-- configured cap, and applies it across open receivables oldest-first.
-- Returns the amount withheld (0 when nothing is owed or the cap is 0).
create function public.apply_payout_offset(
  p_chw_id uuid,
  p_obligation_id uuid,
  p_amount_usdc numeric
) returns numeric
language plpgsql security definer set search_path = '' as $$
declare
  v_percent numeric;
  v_cap numeric;
  v_remaining numeric;
  v_take numeric;
  v_total numeric := 0;
  v_receivable public.payout_receivables;
begin
  if p_amount_usdc is null or p_amount_usdc <= 0 then return 0; end if;

  select max_offset_percent into v_percent from public.payout_recovery_config where id;
  v_cap := round(p_amount_usdc * coalesce(v_percent, 0) / 100, 7);
  v_remaining := v_cap;

  for v_receivable in
    select * from public.payout_receivables
      where chw_id = p_chw_id and status = 'open'
      order by opened_at asc, id asc
      for update
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, v_receivable.outstanding_usdc);
    if v_take <= 0 then continue; end if;

    insert into public.payout_recovery_entries (
      receivable_id, kind, amount_usdc, offset_obligation_id
    ) values (v_receivable.id, 'offset', v_take, p_obligation_id)
    on conflict (receivable_id, offset_obligation_id) do nothing;
    if not found then continue; end if;

    update public.payout_receivables set
      recovered_usdc = recovered_usdc + v_take,
      outstanding_usdc = outstanding_usdc - v_take,
      status = case when outstanding_usdc - v_take = 0
                    then 'recovered'::public.payout_receivable_status
                    else 'open'::public.payout_receivable_status end,
      closed_at = case when outstanding_usdc - v_take = 0 then now() else closed_at end
      where id = v_receivable.id;

    insert into public.payout_recovery_audit (receivable_id, action, detail)
      values (v_receivable.id, 'offset',
        jsonb_build_object('amount_usdc', v_take, 'obligation_id', p_obligation_id));

    v_remaining := v_remaining - v_take;
    v_total := v_total + v_take;
  end loop;

  return v_total;
end;
$$;

-- Records a CHW on-chain repayment identified by its memo reference.
-- Idempotent on the transaction hash.
create function public.record_payout_repayment(
  p_memo_reference text,
  p_transaction_hash text,
  p_amount_usdc numeric
) returns public.payout_receivables
language plpgsql security definer set search_path = '' as $$
declare v_receivable public.payout_receivables; v_take numeric;
begin
  if p_amount_usdc is null or p_amount_usdc <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_REPAYMENT_AMOUNT';
  end if;

  select * into v_receivable from public.payout_receivables
    where id::text = p_memo_reference or obligation_id::text = p_memo_reference
    for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RECEIVABLE_NOT_FOUND';
  end if;

  insert into public.payout_recovery_entries (
    receivable_id, kind, amount_usdc, repayment_tx_hash, memo_reference
  ) values (v_receivable.id, 'repayment', p_amount_usdc, p_transaction_hash, p_memo_reference)
  on conflict (repayment_tx_hash) do nothing;
  if not found then
    select * into v_receivable from public.payout_receivables where id = v_receivable.id;
    return v_receivable;
  end if;

  if v_receivable.status <> 'open' then
    raise exception using errcode = '22023', message = 'RECEIVABLE_NOT_OPEN';
  end if;

  v_take := least(p_amount_usdc, v_receivable.outstanding_usdc);

  update public.payout_receivables set
    recovered_usdc = recovered_usdc + v_take,
    outstanding_usdc = outstanding_usdc - v_take,
    status = case when outstanding_usdc - v_take = 0
                  then 'recovered'::public.payout_receivable_status
                  else 'open'::public.payout_receivable_status end,
    closed_at = case when outstanding_usdc - v_take = 0 then now() else closed_at end
    where id = v_receivable.id
    returning * into v_receivable;

  insert into public.payout_recovery_audit (receivable_id, action, detail)
    values (v_receivable.id, 'repayment',
      jsonb_build_object('amount_usdc', v_take, 'tx_hash', p_transaction_hash,
                         'memo_reference', p_memo_reference));
  return v_receivable;
end;
$$;

create function public.request_payout_writeoff(
  p_receivable_id uuid,
  p_amount_usdc numeric,
  p_reason_code text,
  p_actor_id uuid
) returns public.payout_writeoff_requests
language plpgsql security definer set search_path = '' as $$
declare v_receivable public.payout_receivables; v_row public.payout_writeoff_requests;
begin
  select * into v_receivable from public.payout_receivables
    where id = p_receivable_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RECEIVABLE_NOT_FOUND';
  end if;
  if v_receivable.status <> 'open' then
    raise exception using errcode = '22023', message = 'RECEIVABLE_NOT_OPEN';
  end if;
  if p_amount_usdc is null or p_amount_usdc <= 0
     or p_amount_usdc > v_receivable.outstanding_usdc then
    raise exception using errcode = '22023', message = 'INVALID_WRITEOFF_AMOUNT';
  end if;

  insert into public.payout_writeoff_requests (
    receivable_id, amount_usdc, reason_code, requested_by
  ) values (p_receivable_id, p_amount_usdc, p_reason_code, p_actor_id)
  returning * into v_row;

  insert into public.payout_recovery_audit (receivable_id, action, actor_id, detail)
    values (p_receivable_id, 'writeoff_requested', p_actor_id,
      jsonb_build_object('request_id', v_row.id, 'amount_usdc', p_amount_usdc,
                         'reason_code', p_reason_code));
  return v_row;
end;
$$;
