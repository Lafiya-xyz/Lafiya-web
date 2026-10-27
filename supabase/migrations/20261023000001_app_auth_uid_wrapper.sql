-- Migration: app_auth.current_user_id() wrapper (Issue #798 — Supabase exit hedges, Tier 1)
--
-- Creates a thin schema+function that all *new* RLS policies should reference
-- instead of calling auth.uid() directly. When the time comes to exit
-- Supabase/GoTrue, this single function is retargeted (e.g. to read
-- current_setting('request.jwt.claims')::json->>'sub') and every policy that
-- uses it migrates without touching individual policy SQL.
--
-- Existing policies continue to call auth.uid() (which now delegates here),
-- so this migration is a no-op for running behaviour.

set search_path = '';

-- Dedicated schema keeps the exit-hedge surface clearly separate from the
-- GoTrue-owned auth schema.
create schema if not exists app_auth;

-- Grant usage to the roles Supabase auto-creates so RLS policies can call the
-- function regardless of which role is executing the query.
grant usage on schema app_auth to anon, authenticated, service_role;

-- current_user_id() is the stable, portable name. It delegates to auth.uid()
-- today; a future migration replaces the body without touching any policies.
create or replace function app_auth.current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select auth.uid();
$$;

comment on function app_auth.current_user_id() is
  'Portable user-identity accessor. All new RLS policies use this wrapper instead '
  'of calling auth.uid() directly. Retarget the body here when exiting GoTrue. '
  'See docs/exit-strategy/supabase-exit-strategy.md §3 and ADR-005.';

-- Grant execute so all three roles can resolve the function in USING / WITH
-- CHECK clauses.
grant execute on function app_auth.current_user_id() to anon, authenticated, service_role;
