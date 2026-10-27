#!/usr/bin/env bash
# restore-drill.sh — Rehearse the Supabase exit procedure against a vanilla
# Postgres instance. Run quarterly; record results in compliance evidence.
#
# Usage:
#   POSTGRES_URL=postgres://user:pass@localhost:5432/lafiya_restore \
#     bash scripts/exit-strategy/restore-drill.sh
#
# Environment:
#   POSTGRES_URL         Target vanilla Postgres connection string (required)
#   SKIP_MIGRATION       Set to "1" to skip the migration step (re-run verify only)
#   SUPABASE_DB_URL      Source Supabase Postgres URL for pg_dump (optional;
#                        only needed if seeding from a live project)
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed — see output for details

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/supabase/migrations"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-vanilla-restore.mjs"
SEED_FILE="${REPO_ROOT}/supabase/seed.sql"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[restore-drill]${NC} $*"; }
warn() { echo -e "${YELLOW}[restore-drill WARN]${NC} $*"; }
fail() { echo -e "${RED}[restore-drill FAIL]${NC} $*"; exit 1; }

# ── Preflight ──────────────────────────────────────────────────────────────────

[[ -z "${POSTGRES_URL:-}" ]] && fail "POSTGRES_URL is required"
command -v psql  >/dev/null 2>&1 || fail "psql not found"
command -v node  >/dev/null 2>&1 || fail "node not found"

log "Target: ${POSTGRES_URL%%@*}@…"
log "Repo root: ${REPO_ROOT}"

# ── Step 1: Bootstrap required roles and auth.uid() stub ─────────────────────

if [[ "${SKIP_MIGRATION:-0}" != "1" ]]; then
  log "Step 1: Creating Supabase-equivalent roles and auth schema stub…"
  psql "${POSTGRES_URL}" <<'SQL'
-- Roles that Supabase manages; must exist before migrations run.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

-- Minimal auth schema: auth.users (referenced by profiles FK) and auth.uid().
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true), ''
  )::json->>'sub'
  ::uuid;
$$;

-- extensions schema required by pgcrypto reference in migrations
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- storage schema stub (policies reference storage.foldername / storage.objects)
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id   text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id  text REFERENCES storage.buckets(id),
  name       text NOT NULL,
  owner      uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT string_to_array(name, '/');
$$;
SQL
  log "Step 1: Roles and auth schema created."

  # ── Step 2: Run all migrations ───────────────────────────────────────────────

  log "Step 2: Running migrations from ${MIGRATIONS_DIR}…"
  MIGRATION_COUNT=0
  MIGRATION_FAILURES=0
  for f in "${MIGRATIONS_DIR}"/*.sql; do
    filename="$(basename "$f")"
    if psql "${POSTGRES_URL}" -f "$f" >/dev/null 2>&1; then
      log "  ✓ ${filename}"
      MIGRATION_COUNT=$((MIGRATION_COUNT + 1))
    else
      warn "  ✗ ${filename} — captured stderr:"
      psql "${POSTGRES_URL}" -f "$f" 2>&1 | sed 's/^/    /' || true
      MIGRATION_FAILURES=$((MIGRATION_FAILURES + 1))
    fi
  done
  log "Step 2: ${MIGRATION_COUNT} migrations applied, ${MIGRATION_FAILURES} failures."

  # ── Step 3: Seed data ────────────────────────────────────────────────────────

  if [[ -f "${SEED_FILE}" ]]; then
    log "Step 3: Applying seed data from ${SEED_FILE}…"
    psql "${POSTGRES_URL}" -f "${SEED_FILE}" >/dev/null 2>&1 || warn "Seed file produced warnings (non-fatal)"
  else
    log "Step 3: No seed file found — inserting minimal test fixtures…"
    psql "${POSTGRES_URL}" <<'SQL'
DO $$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_card_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_user_id, 'restore-drill@example.invalid');
  INSERT INTO public.profiles (
    user_id, card_public_id, name, blood_group, genotype, language,
    allergies, medications, chronic_conditions, emergency_contacts
  ) VALUES (
    v_user_id, v_card_id,
    'Restore Drill Patient', 'O+', 'AA', 'en',
    ARRAY['Penicillin'], ARRAY[]::text[], ARRAY[]::text[],
    '[{"name":"Test Contact","phone":"+2348012345678","relationship":"Sibling"}]'::jsonb
  );
  INSERT INTO public.profile_secrets (user_id, secret)
  VALUES (v_user_id, encode(gen_random_bytes(32), 'hex'));
END $$;
SQL
  fi
  log "Step 3: Seed data applied."
fi  # end SKIP_MIGRATION

# ── Step 4: Verify restore ───────────────────────────────────────────────────

log "Step 4: Running post-restore verification…"
TARGET_DATABASE_URL="${POSTGRES_URL}" node "${VERIFY_SCRIPT}"
VERIFY_EXIT=$?

if [[ $VERIFY_EXIT -eq 0 ]]; then
  log "Restore drill PASSED. Record this run in compliance evidence."
else
  fail "Restore drill FAILED with exit code ${VERIFY_EXIT}. See output above."
fi
