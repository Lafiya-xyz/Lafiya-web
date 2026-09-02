# Contributing to Lafiya

Thank you for your interest in contributing to Lafiya! Lafiya is a patient-owned emergency health card on Stellar, designed as an open-source Digital Public Good. By participating in this project, you help build trusted, decentralized healthcare access.

This guide outlines our development workflow, coding standards, and how to coordinate changes across the Lafiya ecosystem.

---

## Code of Conduct & License

By contributing to this repository, you agree that your contributions will be licensed under the project's [MIT License](LICENSE) and that you will follow standard open-source collaboration best practices.

---

## Getting Started & Local Setup

Before you start writing code, please set up your local development environment:

1. **Install Dependencies**: Run `npm install`.
2. **Local Supabase & Configuration**: Follow the **Quick Start** instructions in the [README.md](README.md#quick-start) to start the local database and populate your environment variables.
3. **Run Dev Server**: Start the local server using `npm run dev`.

---

## Before Opening a PR

Run these commands locally in the order listed. Each one catches a different class of problem, and the order is cheapest-first.

```bash
npm run lint          # ESLint + Prettier — catches style and obvious code issues
npm run typecheck     # tsc --noEmit — catches type errors without a full build
npm test              # Vitest unit/component tests (jsdom, no Supabase needed)
npm run build         # Next.js production build — catches module graph and env errors
```

> **Requires a running local Supabase** (see [Local Setup](#getting-started--local-setup) and the [Supabase troubleshooting](#troubleshooting-local-supabase) section below):
>
> ```bash
> npx supabase start
> npm run test:integration   # RLS + RPC tests against a real local Postgres
> ```

These match what CI runs on every push and pull request (`.github/workflows/ci.yml` — `lint` → `typecheck` → `migration:lint` → `test` → `build`). If all of the above pass locally, CI should be green.

---

## Branching & Commit Conventions

To maintain a clean and legible project history, we use the following conventions:

### Branch Naming

Create feature or bugfix branches from `main` using the following prefixes:

- `feat/description` — for new features (e.g., `feat/add-avatar-upload`)
- `fix/description` — for bug fixes (e.g., `fix/qr-code-contrast`)
- `docs/description` — for documentation updates (e.g., `docs/update-api-docs`)
- `chore/description` — for build tools, dependencies, or config changes (e.g., `chore/bump-zod`)

### Commit Messages

We follow **Conventional Commits**:

- `feat: add support for multiple emergency contacts`
- `fix: resolve RLS policy bug on profiles table`
- `docs: update deployment guidelines`
- `chore: update dependencies`

---

## Supabase Database Migrations

Lafiya uses Supabase for database, authentication, and file storage.

### 1. Creating a Migration

If your change requires database alterations (e.g., adding a table, adding a column, modifying an RLS policy, or editing an RPC function):

1. Generate a new migration file:
   ```bash
   npx supabase migration new <migration_name>
   ```
2. Open the newly created SQL file under `supabase/migrations/` and write your DDL/SQL code.

### 2. Validating Locally

Apply migrations locally and seed default data to verify changes:

```bash
npx supabase db reset
```

This command recreates the local database schema, applies all migrations in chronological order, and executes `supabase/seed.sql` to populate the development fixtures.

### 3. Critical Constraint: Hand-Authored Types

To avoid network dependencies on a hosted project during development/builds, **there is no `supabase gen types` step** in this codebase. Instead, database types are hand-maintained in [lib/supabase/types.ts](lib/supabase/types.ts).

When updating the database schema:

1. Manually update [lib/supabase/types.ts](lib/supabase/types.ts) to match the SQL schema changes.
2. **Rule: Use `type` aliases, NEVER `interface`**.
   - **Why**: `supabase-js`'s generic type checking requires the database schema to extend `Record<string, GenericTable>`. TypeScript's structural `extends` check only recognizes plain object `type` aliases as satisfying index signatures.
   - **The Risk**: If you use an `interface` (even deep inside nested types like emergency contacts or custom row models), the database query result types will **silently collapse to `never`** without any compilation error at the `Database` declaration. The error will only manifest downstream at `.from(...).select(...)` calls, making it hard to debug.

---

## Troubleshooting local Supabase

The most common failure modes when running `supabase start` or `supabase db reset`, in order of frequency:

### Docker daemon not running

**Symptom:**
```
Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.
Is the docker daemon running?
```

**Fix:** Start Docker Desktop (or your Docker daemon) and wait until it is fully ready before retrying:
```bash
open -a Docker   # macOS — wait for the whale icon in the menu bar
supabase start
```

---

### Port already in use (stale container from a previous session)

**Symptom:**
```
Error: listen tcp 0.0.0.0:54321: bind: address already in use
```
or similar for ports 54322, 54323, 54324, or 54329.

**Fix:** Stop the existing Supabase containers, then restart:
```bash
supabase stop
supabase start
```

If `supabase stop` itself fails or the port is held by something unrelated:
```bash
docker ps                  # identify the container holding the port
docker stop <container_id>
supabase start
```

---

### Migration drift (local schema out of sync with migration files)

**Symptom:** `npm run test:integration` fails with a table-not-found, column-not-found, or RLS policy error shortly after pulling new commits.

**Fix:** Reset the local database. This drops and recreates the schema, replays all migrations in order, and re-runs the seed:
```bash
supabase db reset
```

> **Note:** `supabase db reset` destroys all local data. For development purposes this is fine — `seed.sql` re-creates the demo patient fixture (`demo@lafiya.test`). Do not run `db reset` against a hosted project URL.

---

### Stale generated types after a schema change

**Symptom:** TypeScript errors in `lib/supabase/types.ts` after `supabase db reset`, or `.from(...).select(...)` calls that collapse to `never`.

**Fix:** Manually update [`lib/supabase/types.ts`](lib/supabase/types.ts) to match the new schema (see [Critical Constraint: Hand-Authored Types](#3-critical-constraint-hand-authored-types) above). There is no `supabase gen types` step. The mismatch is usually a missing column, a renamed table, or a new RPC function. Compare the type file against the migration files under `supabase/migrations/` to find the delta.

---

## Coordinating Cross-Repo Changes (Shared Contracts)

Lafiya is organized across five separate repositories in the `lafiya-xyz` organization. Some interfaces form **Shared Contracts** and must stay in sync across repositories.

If your changes affect any of the following, you **must** flag it in your Pull Request:

1. **Attestation Schema**: The structure of the on-chain attestation (mirrored in `lafiya-contracts` as a Soroban Rust struct):
   ```rust
   Attestation {
       record_hash: BytesN<32>
       attester: Address
       timestamp: u64
   }
   ```
   If you change hashing logic or fields in `lafiya-web`, the corresponding smart contracts must be updated in tandem.
2. **Emergency Data Model**: The specific decision-relevant patient fields shown on the public card page (documented in `lafiya-docs` concept papers). Casing, field names, and structures must remain identical across the stack.
3. **Environment & Configuration Keys**: Shared configuration keys in `.env.example` (such as contract IDs or stellar RPC urls).

Always mention in your PR description if you have touched any of these contracts so the repository maintainers can coordinate the matching changes in the other repositories.

---

## Testing offline mode locally

The service worker (`public/sw.js`, registered from `app/offline-register.tsx`)
can't be exercised under jsdom/Vitest — it needs a real browser. If your
change touches `app/offline-register.tsx`, `public/sw.js`, or
`public/offline-cache-helpers.js`, verify it manually against a running
build before opening a PR:

1. **Build and run production mode.** Registration is skipped in
   `next dev`, so use a production build:
   ```bash
   npm run build && npm start
   ```
2. **Warm the cache.** With DevTools open, visit a card you can authenticate
   to and consent to offline caching, e.g.
   `http://localhost:3000/card/11111111-1111-1111-1111-111111111111`
   (seeded demo patient). Open DevTools ▸ **Application** tab ▸
   **Service Workers** and confirm `sw.js` shows as `activated and running`.
   Under **Cache Storage**, confirm `lafiya-emergency-envelopes-v1` now has
   an entry for that card.
3. **Clear state to start from a clean slate.** In DevTools ▸ Application ▸
   **Storage**, click **Clear site data** if you need to re-test registration
   or admission from scratch (do this between test runs so a stale envelope
   from a previous change doesn't mask a regression).
4. **Simulate offline mode.** In DevTools ▸ **Network** tab, change the
   throttling dropdown from "No throttling" to **Offline**. Reload the card
   page.
   - **Expected:** the cached card still renders — name, blood group,
     allergies, medications, and emergency contacts are all visible, with a
     notice that authorization/revocation cannot be checked while offline
     and separate timestamps for when the record was last updated and when
     it was cached on this device.
5. **Verify scope.** While still offline, navigate to a card id you have
   never visited. Confirm you get a "No cached card available" message, not
   a partial or guessed render.
6. **Go back online** (reset the Network dropdown to "No throttling") and
   reload — confirm the live card renders again and the cached envelope is
   refreshed.

This procedure was followed on a clean checkout to confirm it works before
being documented here; see `docs/card-caching-strategy.md` for the caching
contract these steps are verifying.

---

## Pull Request Expectations & Checklist

Every Pull Request must be verified before merging. Please ensure the following checklist is completed:

### 1. Build and Quality Checks

Run the following verification pipeline locally:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

- **Linting**: No ESLint/Prettier warnings or errors.
- **Typechecking**: No TypeScript errors.
- **Unit/Component Tests**: All unit/component tests in `tests/` pass.
- **Build**: The Next.js production build completes without warnings.

### 2. Integration & RLS/RPC Tests

Ensure your local Supabase instance is running and verify database-specific behavior:

```bash
npx supabase start
npm run test:integration
```

- Every schema change (e.g., changes to Row-Level Security (RLS) policies or Postgres functions) **must** have a corresponding integration test in `tests/integration/`.

### 3. Checklist Summary

Before hitting submit on your PR:

- [ ] Code builds, lints, and passes type-checking.
- [ ] Unit and component tests pass.
- [ ] Integration tests pass against a running local Supabase.
- [ ] If a database migration was added, the hand-authored types in `lib/supabase/types.ts` were updated as `type` aliases.
- [ ] You have declared whether this PR impacts a shared cross-repo contract.
