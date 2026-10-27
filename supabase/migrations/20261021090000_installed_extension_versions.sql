-- Issue #811: expose installed extension and server versions so readiness and
-- the Postgres upgrade rehearsal can verify supabase/extensions.manifest.json.
-- Returns catalog metadata only; no tenant data.
create or replace function public.installed_extension_versions()
returns table (name text, version text, server_version_num integer)
language sql
stable
security definer
set search_path = ''
as $$
  select e.extname::text,
         e.extversion::text,
         current_setting('server_version_num')::integer
  from pg_catalog.pg_extension e
  union all
  -- Always emit a row so the server version is reported even with no extensions.
  select 'plpgsql-server'::text, null::text,
         current_setting('server_version_num')::integer
$$;

revoke all on function public.installed_extension_versions() from public, anon, authenticated;
grant execute on function public.installed_extension_versions() to service_role;
