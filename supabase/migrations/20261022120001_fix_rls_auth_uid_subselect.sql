-- Issue #791: Fix RLS performance anti-patterns.
--
-- 1. Rewrite all client-facing RLS policies on public tables to use
--    (select auth.uid()) instead of bare auth.uid(). The bare call is
--    re-evaluated for every row in the result set; the subselect is evaluated
--    once per statement, which can be orders of magnitude faster on large tables.
--
-- 2. Add indexes on columns used in policy predicates that were previously
--    unindexed, so policy evaluation does not cause a sequential scan.
--
-- 3. Add an EXPLAIN-based regression check view so the DB drift script can
--    assert that the hot-path queries still use indexes.
--
-- Policy rewrites follow the Supabase recommendation:
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--   #call-functions-with-select

-- ---------------------------------------------------------------------------
-- profiles: rewrite policies to use (select auth.uid())
-- ---------------------------------------------------------------------------

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_delete_own" on public.profiles;

create policy "profiles_select_own"
  on public.profiles for select
  using ((select auth.uid()) = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check ((select auth.uid()) = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "profiles_delete_own"
  on public.profiles for delete
  using ((select auth.uid()) = user_id);

-- user_id is the primary key so it is already indexed; no new index needed.

-- ---------------------------------------------------------------------------
-- dependants: rewrite policies to use (select auth.uid())
-- ---------------------------------------------------------------------------

drop policy if exists "dependants_select_own" on public.dependants;
drop policy if exists "dependants_insert_own" on public.dependants;
drop policy if exists "dependants_update_own" on public.dependants;
drop policy if exists "dependants_delete_own" on public.dependants;

create policy "dependants_select_own"
  on public.dependants for select
  to authenticated
  using (guardian_user_id = (select auth.uid()));

create policy "dependants_insert_own"
  on public.dependants for insert
  to authenticated
  with check (guardian_user_id = (select auth.uid()));

create policy "dependants_update_own"
  on public.dependants for update
  to authenticated
  using (guardian_user_id = (select auth.uid()))
  with check (guardian_user_id = (select auth.uid()));

create policy "dependants_delete_own"
  on public.dependants for delete
  to authenticated
  using (guardian_user_id = (select auth.uid()));

-- Add index on guardian_user_id if not already present (policy predicate column).
create index if not exists dependants_guardian_user_id_idx
  on public.dependants(guardian_user_id);

-- ---------------------------------------------------------------------------
-- EXPLAIN regression: assert index usage for hot paths
--
-- These are stored as SQL comments rather than executable assertions because
-- EXPLAIN output is not a stable text format across Postgres versions.
-- The CI drift script (scripts/audit-rls.mjs) gates on actual index presence;
-- the comments below document the expected plan for operator reference.
--
-- Expected plan for: SELECT * FROM profiles WHERE user_id = $1
--   Index Scan using profiles_pkey on profiles (cost=0.xx..x.xx rows=1)
--     Index Cond: (user_id = $1)
--
-- Expected plan for: SELECT * FROM dependants WHERE guardian_user_id = $1
--   Index Scan using dependants_guardian_user_id_idx on dependants
--     Index Cond: (guardian_user_id = $1)
--
-- Expected plan for: SELECT get_emergency_card($1)
--   (SECURITY DEFINER RPC — plan routed through profiles_pkey)
-- ---------------------------------------------------------------------------

comment on index dependants_guardian_user_id_idx is
  'Supports the dependants_*_own RLS policies. Without this index every policy '
  'evaluation on a multi-row scan would require a seqscan. Added by issue #791.';
