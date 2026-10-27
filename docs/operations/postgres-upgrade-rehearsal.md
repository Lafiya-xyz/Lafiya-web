# Postgres and extension upgrade rehearsal

Issue #811. Upgrading Postgres or an extension (`pgcrypto`, `pg_cron`,
partitioning behaviour, `SECURITY DEFINER` search paths) can silently change
behaviour that security-critical functions such as `get_emergency_card()`
depend on. Every upgrade is rehearsed before production.

## Version manifest

`supabase/extensions.manifest.json` records the expected Postgres major and
minimum extension versions. It is verified in two places:

- **Readiness** — `GET /api/internal/readiness` calls
  `public.installed_extension_versions()` (service role only) and reports
  `components.databaseExtensions` as `ok`, `mismatch` or `unknown`. A
  `mismatch` returns `503`, so an unrehearsed upgrade keeps new instances out
  of rotation. Installed versions are never returned by the probe.
- **Rehearsal** — `npm run db:upgrade-rehearsal` checks the manifest against
  the rehearsal database.

## Running the rehearsal

Actions → **Postgres upgrade rehearsal** → Run workflow, with the version
matrix to test (default `[17, 15]`). For each version the job:

1. sets `[db].major_version` in `supabase/config.toml`;
2. starts a local Supabase stack and runs `supabase db reset`, replaying every
   migration and loading the synthetic, PHI-free `supabase/seed.sql`;
3. verifies the extension manifest and EXPLAINs the hot paths — emergency read
   (`profiles.card_public_id`), profile read (`profiles.user_id`) and the
   emergency access log (`card_access_events`) — against
   `scripts/pg-plan-baseline.json`, failing on a cost increase over 1.5× or a
   new sequential scan (results in the job summary);
4. runs the schema drift, RLS audit and integration suites.

Locally: `npm run db:start && npm run db:reset && npm run db:upgrade-rehearsal`.
Regenerate the plan baseline on the current production version with
`npm run db:upgrade-rehearsal -- --update` and commit it.

## Upgrade procedure

1. Green rehearsal for the target version on the latest `main`.
2. In one PR: bump `major_version` in `supabase/config.toml`, update
   `supabase/extensions.manifest.json`, and refresh the plan baseline if plans
   intentionally changed. Link the rehearsal run in the PR.
3. Upgrade staging (Supabase dashboard → Settings → Infrastructure), deploy the
   PR to staging, and confirm readiness reports `databaseExtensions: ok`.
4. Schedule the production upgrade in a low-traffic window and announce it.
   **Expected downtime:** Supabase in-place major upgrades take the database
   offline for roughly 10–30 minutes depending on size; extension minor
   upgrades (`alter extension … update`) are online.
5. After the upgrade, deploy the release and confirm readiness, then smoke-test
   an emergency card read and a profile read.

## Rollback

A Postgres major upgrade cannot be downgraded in place.

- **Before the upgrade:** take a manual backup and confirm point-in-time
  recovery is enabled; note the restore point.
- **If checks fail after the upgrade:** keep the previous application release
  serving (readiness `mismatch` keeps new instances out of rotation), then
  restore the pre-upgrade backup into a new project on the previous major,
  repoint `NEXT_PUBLIC_SUPABASE_URL` / keys, and redeploy. Expect 30–90 minutes
  of read-only or degraded service; the offline emergency card cache
  continues to serve previously viewed cards.
- **Extension-only regression:** `alter extension <name> update to '<previous>'`
  when a downgrade path exists; otherwise follow the full restore.
- Record the incident and add the failing behaviour to the rehearsal before
  retrying.
