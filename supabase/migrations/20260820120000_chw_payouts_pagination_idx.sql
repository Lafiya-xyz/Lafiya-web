-- Composite index supporting the new CHW payout history API. The route
-- handler paginates the caller's own rows ordered by (created_at DESC,
-- id DESC); without this index Postgres has to do an extra sort on top of
-- the existing single-column chw_payouts_chw_id_idx. The id descending
-- component is the standard keyset-pagination tiebreaker for the
-- (verifying second) sub-second created_at collisions on a single CHW.
--
-- Additive only: no change to chw_payouts schema, RLS, or existing
-- migration semantics. The existing chw_payouts_chw_id_idx remains in
-- place so other lookups (e.g. status-filtered joins) are unaffected.

create index if not exists chw_payouts_chw_id_created_at_id_idx
  on public.chw_payouts (chw_id, created_at desc, id desc);
