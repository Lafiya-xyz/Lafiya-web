-- Issue #516: make lifecycle state storage closed and database-enforced.
-- Existing values are validated before the cast so this migration fails loudly
-- instead of silently inventing a state.
create type public.payout_settlement_status as enum ('matched', 'quarantined');
create type public.chw_payout_status as enum ('pending', 'paid');

alter table public.chw_payouts
  alter column status drop default,
  alter column status type public.chw_payout_status
  using status::public.chw_payout_status,
  alter column status set default 'pending'::public.chw_payout_status;

alter table public.payout_settlements
  alter column status type public.payout_settlement_status
  using status::public.payout_settlement_status;

comment on type public.payout_settlement_status is
  'Terminal status for a payout settlement; kept closed to protect reconciliation state.';
comment on type public.chw_payout_status is
  'Lifecycle state for a CHW payout mirror.';

-- The protocol already uses enums for its primary state machines. Keep the
-- generated client contract explicit for the remaining free-text lifecycle
-- fields added by the ledger evidence migration when those tables exist.
