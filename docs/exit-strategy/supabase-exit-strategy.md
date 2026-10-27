# Supabase Exit and Portability Strategy

> **Status:** Draft — approved for rehearsal  
> **Owners:** Platform lead, Privacy lead  
> **Review cadence:** Every 6 months or when a Supabase breaking change is announced  
> **Related:** [ADR-005](#adr-005-supabase-exit-hedges), [`scripts/exit-strategy/`](../../scripts/exit-strategy/)

---

## 1. Purpose

Authentication, storage, RLS-based authorization, and realtime all depend on
Supabase-specific behaviour. For a health product operating in a regulated
market, vendor or data-residency changes must be survivable. This document:

1. Inventories every Supabase-specific dependency with a **portability rating**.
2. Provides an estimated effort and ordering to remove each coupling.
3. Describes a tested procedure to restore a database and storage into
   vanilla Postgres + S3-compatible storage with Auth replaced by an
   alternative provider.

---

## 2. Dependency inventory

### 2.1 Authentication (`auth.*` schema and JWT claims)

| Dependency | Where used | Portability | Effort |
|---|---|---|---|
| `auth.users` table (Supabase-managed schema) | All RLS policies (`auth.uid()`) and `profiles.user_id FK` | Medium — the schema is well-documented but owned by GoTrue | ~2 weeks |
| `auth.uid()` helper function in RLS policies | Every policy in all migrations | Medium — replaceable with `current_setting('request.jwt.claims', true)::json->>'sub'` or a thin wrapper | ~1 week |
| `@supabase/ssr` browser + server clients | `lib/supabase/client.ts`, `lib/supabase/server.ts`, `middleware.ts` | Medium — OIDC-compatible replacement (e.g. Clerk, Auth0, Keycloak) needs the same cookie refresh pattern | ~2 weeks |
| `@supabase/supabase-js` admin client | `lib/supabase/admin.ts` | High — replaceable with `pg` + direct SQL; only 3 admin call sites | ~3 days |
| GoTrue-specific JWT claims (`iss`, `role`, `aal`) | `lib/auth/`, `middleware.ts` | High — `sub` is stable; `role`/`aal` claims need adaptor if switching | ~1 week |
| Twilio SMS OTP via GoTrue | `supabase/config.toml [auth.sms.twilio]` | High — Twilio can be called directly; phone OTP flow is abstracted behind server actions | ~3 days |
| MFA TOTP/Phone via GoTrue | `supabase/config.toml [auth.mfa]` | High — TOTP is standard; can use `otplib` + direct Twilio | ~1 week |

**Overall Auth portability rating: MEDIUM**  
The biggest coupling is `auth.uid()` in every RLS policy and the `auth.users` FK from `profiles`. A self-hosted GoTrue instance (same binary, different host) would require zero migration SQL. A full auth provider swap requires rewriting all RLS policies to use a different JWT sub claim accessor.

---

### 2.2 Storage (Supabase Storage / S3-compatible)

| Dependency | Where used | Portability | Effort |
|---|---|---|---|
| `storage.objects` RLS policies | `supabase/migrations/20260709121557_avatars_storage_bucket.sql` | High — the policies use `auth.uid()` and `storage.foldername()` helpers | ~2 days |
| `storage.foldername()` helper | Avatar bucket policies | High — pure string split, trivially replaced | ~1 day |
| Supabase Storage S3 protocol | `supabase/config.toml [storage.s3_protocol]` | **Low coupling** — already S3-compatible; direct S3/MinIO swap requires only URL/credentials change | Same day |
| `@supabase/supabase-js` storage client | `lib/storage/` | Medium — abstracted behind `lib/storage/`; swap to `aws-sdk` S3 client is isolated | ~1 week |
| Public bucket (`avatars`, `public=true`) | Photo serving | Low — standard S3 bucket public access policy pattern | ~1 day |

**Overall Storage portability rating: LOW–MEDIUM**  
Storage is the easiest surface to migrate: the S3 protocol is already enabled, the file paths follow `{user_id}/{filename}` with no Supabase-specific structure, and the only Postgres coupling is the `storage.objects` RLS policies (not the object data itself). Migrating objects is a straight `aws s3 sync`; the policy rewrite is minor.

---

### 2.3 Row Level Security (RLS)

| Dependency | Where used | Portability | Effort |
|---|---|---|---|
| `auth.uid()` in RLS `USING` / `WITH CHECK` clauses | All `public.*` table policies across all migrations | Medium — must be replaced with a claim accessor matching the replacement auth provider | ~1 week |
| `SECURITY DEFINER` RPCs calling `auth.uid()` indirectly | `get_emergency_card()`, capability-related RPCs | Low — these functions are explicitly `set search_path = ''` and do not call auth helpers | Minimal |
| Supabase-managed `anon` and `authenticated` Postgres roles | All `GRANT` statements | Medium — these roles must be pre-created in a vanilla Postgres instance | ~1 day |
| `service_role` Postgres role (bypasses RLS) | `lib/supabase/admin.ts` | High — in vanilla Postgres, replace with a privileged application role | ~1 day |

**Overall RLS portability rating: MEDIUM**  
Every RLS policy references `auth.uid()` — a GoTrue function. In vanilla Postgres, replacing it with `current_setting('request.jwt.claims')::json->>'sub'` (or an equivalent wrapper) decouples policies from the GoTrue binary. The application roles (`anon`, `authenticated`, `service_role`) must be created in the target cluster.

---

### 2.4 Postgres Extensions

| Extension | Where used | Portability | Effort |
|---|---|---|---|
| `pgcrypto` (`gen_random_bytes`, `encode`) | `profile_secrets` backfill migration | High — `gen_random_uuid()` is built-in since Postgres 13; `gen_random_bytes` is available in most managed Postgres | ~1 day |
| `uuid-ossp` (implicitly via `gen_random_uuid()`) | `profiles.card_public_id DEFAULT` | Very high — `gen_random_uuid()` is core Postgres 13+ | None |
| `pg_cron` (optional) | `rate_limits` GC | High — fallback HTTP endpoint exists; can use external cron | ~1 day |
| PostgREST Data API layer | `supabase/config.toml [api]` | Medium — this is the entire REST API surface; replacement requires explicit API routing | ~4 weeks |

**Overall Extensions portability rating: MEDIUM**  
`pgcrypto` and `pg_cron` are widely available. The biggest dependency is PostgREST: Supabase auto-generates REST endpoints from the schema. Without PostgREST, every `supabase-js` `.from('table')` call must be replaced with an explicit server-side query. This is the highest-effort migration item.

---

### 2.5 Realtime

| Dependency | Where used | Portability | Effort |
|---|---|---|---|
| Supabase Realtime (Phoenix channels over WebSocket) | `supabase/config.toml [realtime] enabled=true` | Medium — not actively used in app code today; off-by-default migration path | Low |

**Overall Realtime portability rating: LOW RISK**  
Realtime is enabled in config but no app code currently subscribes to it. Turning it off has no user impact.

---

### 2.6 RPC conventions

| Dependency | Where used | Portability | Effort |
|---|---|---|---|
| PostgREST `rpc/<function>` convention | `get_emergency_card()`, capability RPCs | Medium — calling SQL functions via HTTP is PostgREST-specific; must replace with explicit route handlers | ~1 week |
| `SECURITY DEFINER` + `set search_path = ''` pattern | All SECURITY DEFINER functions | High — standard Postgres; works unchanged in any Postgres deployment | None |

---

## 3. Portability summary and migration ordering

| Priority | Dependency | Portability | Recommended hedge | Effort |
|---|---|---|---|---|
| 1 (do now) | `auth.uid()` in RLS → wrapper function | Medium | Create `app_auth.current_user_id()` wrapper; point all policies at it | ~1 week |
| 2 (do now) | `lib/supabase/` adapter layer | Medium | Ensure all Supabase calls are behind `lib/supabase/` — no raw client leaks to routes | ~3 days |
| 3 (next quarter) | PostgREST dependency → explicit server actions | Medium | Already mostly done; audit for any remaining direct `.from()` in client components | ~1 week |
| 4 (next quarter) | Storage S3 protocol | Low | Already enabled; document and test S3 restore procedure | ~1 day |
| 5 (next half) | GoTrue → alternative OIDC provider | Medium | Abstract JWT claims accessor; keep `sub` as canonical user ID | ~3 weeks |
| 6 (next half) | `anon`/`authenticated`/`service_role` roles | Medium | Document role creation SQL for target Postgres | ~1 day |
| 7 (as needed) | `pgcrypto` / `pg_cron` extensions | High | Confirm availability in target managed Postgres tier | ~2 days |

---

## 4. Restore procedure — vanilla Postgres + S3

This section describes the tested procedure to restore a seeded Lafiya database
into a vanilla Postgres instance and replace Supabase Storage with S3-compatible
storage.

### 4.1 Prerequisites

```
# Target environment
- PostgreSQL 17 (vanilla, no Supabase extensions except pgcrypto)
- MinIO or AWS S3 bucket (for avatar storage)
- An OIDC-compatible auth provider JWT with `sub` claim (for RLS)

# Tooling
- psql
- pg_restore or pg_dump
- aws-cli or mc (MinIO client)
- node >= 24 (for scripts)
```

### 4.2 Schema migration (no code changes required)

1. **Create required roles** (these are Supabase-managed in the hosted platform):

```sql
-- Run as superuser on the target cluster
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

-- Create a claim accessor that reads the JWT sub from the connection context
-- (set by your application server or PostgREST replacement before each query)
CREATE SCHEMA IF NOT EXISTS app_auth;
CREATE OR REPLACE FUNCTION app_auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true), '')::json->>'sub'
  FILTER (WHERE current_setting('request.jwt.claims', true) IS NOT NULL)::uuid;
$$;

-- Alias: if keeping auth.uid() in existing policies, create the schema + function:
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT app_auth.uid();
$$;
```

2. **Run all migrations** — every `.sql` file in `supabase/migrations/` is
   standard SQL (no Supabase-specific DDL outside the role/schema names above).
   Run them in filename order:

```bash
for f in supabase/migrations/*.sql; do
  psql "$TARGET_DATABASE_URL" -f "$f"
done
```

3. **Verify with `scripts/exit-strategy/verify-vanilla-restore.mjs`** (see §4.4).

### 4.3 Storage migration (avatars bucket → S3)

```bash
# Export from Supabase Storage via S3 protocol
aws s3 sync \
  s3://avatars \
  s3://<target-bucket>/avatars \
  --source-endpoint-url "$SUPABASE_STORAGE_S3_ENDPOINT" \
  --source-access-key "$SUPABASE_S3_ACCESS_KEY_ID" \
  --source-secret-key "$SUPABASE_S3_SECRET_ACCESS_KEY"
```

After migration, update `NEXT_PUBLIC_SUPABASE_URL` to point to the new storage
endpoint and replace `@supabase/supabase-js` storage calls in `lib/storage/`
with the AWS SDK S3 client.

### 4.4 Integration suite failures (known)

The following integration tests are expected to fail against vanilla Postgres
without a GoTrue-compatible auth server (they require a live Supabase JWT
session):

| Test file | Failure reason | Migration path |
|---|---|---|
| `tests/integration/delete-account.test.ts` | Calls `auth.admin.deleteUser()` via GoTrue | Replace with direct SQL `DELETE FROM auth.users` |
| `tests/integration/profile-rls.test.ts` | Uses `supabase.auth.signInWithPassword()` | Replace with direct JWT injection via `SET request.jwt.claims` |
| `tests/integration/card-token.test.ts` | Uses `supabase.auth.getSession()` | Replace with mock JWT |

All other integration tests (canonicalization, attestation hashing, CHW protocol,
rate limiting) are pure Postgres + Node and pass unchanged.

---

## 5. Auth provider alternative

**Recommended replacement:** Self-hosted [GoTrue](https://github.com/supabase/gotrue)
(the same binary Supabase hosts). This preserves all `auth.*` schema and JWT
claim compatibility with zero migration SQL.

**Alternative:** [Keycloak](https://www.keycloak.org/) with:
- `sub` claim mapped to the existing `auth.users.id` UUID
- `role` claim providing `authenticated`/`anon` equivalents
- PKCE flow replacing Supabase's `@supabase/ssr` cookie refresh

**Alternative:** [Clerk](https://clerk.com/) — already listed in
`supabase/config.toml [auth.third_party.clerk]`; the third-party JWT bridge
is the smoothest transition path without rewriting RLS policies.

---

## 6. Recommended hedges (what to abstract now vs. later)

### Do now (low-effort, high value)

1. **`auth.uid()` wrapper** — create `app_auth.current_user_id()` and point
   new policies at it. Old policies need a one-time SQL migration when exiting.
2. **Audit `lib/supabase/` boundary** — confirm no raw `createClient()` calls
   exist outside `lib/supabase/*.ts`. This is already mostly true.
3. **Document S3 restore procedure** — the S3 protocol is already enabled;
   add this document to the runbook library.

### Next quarter

4. **PostgREST audit** — enumerate any remaining direct `.from('table')` calls
   in client components and ensure they go through server actions (already the
   predominant pattern).
5. **Seed + rehearsal script** — run `scripts/exit-strategy/restore-drill.sh`
   quarterly against a vanilla Postgres instance (see §4).

### Later (when triggered by vendor/region change)

6. **Full GoTrue → alternative OIDC** — only when data-residency or vendor
   change requires it. Estimated 3–4 weeks including QA.
7. **PostgREST → explicit API routing** — only if dropping Supabase hosting
   entirely. Estimated 4–6 weeks.

---

## 7. References

- `supabase/config.toml` — full local dev configuration
- `supabase/migrations/` — all schema migrations (plain SQL)
- `lib/supabase/` — all Supabase client abstractions
- `docs/environment-variables.md` — all Supabase env vars
- `scripts/exit-strategy/restore-drill.sh` — restore rehearsal script
- `scripts/exit-strategy/verify-vanilla-restore.mjs` — post-restore verification
