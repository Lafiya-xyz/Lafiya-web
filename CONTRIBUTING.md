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
4. **Install the pre-commit hook** (one-time per clone): Run `npm run hooks:install`. This wires `scripts/scan-secrets.mjs` into git so secret patterns are caught before they reach the remote.

---

## Common Commands

All commands below are available as `npm run <script>`. Run `npm run` with no arguments to see the full list.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Production build (also runs bundle size check) |
| `npm start` | Start the production server (after `build`) |
| `npm run lint` | ESLint with zero-warning policy |
| `npm run typecheck` | TypeScript type check (no emit) |
| `npm run format` | Auto-format all files with Prettier |
| `npm run format:check` | Check formatting without writing |
| `npm test` | Unit + component tests (Vitest, jsdom) |
| `npm run test:watch` | Vitest in interactive watch mode |
| `npm run test:integration` | RLS + RPC integration tests (requires `npm run db:start`) |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run db:start` | Start local Supabase (`npx supabase start`) |
| `npm run db:stop` | Stop local Supabase |
| `npm run db:reset` | Recreate local DB from migrations + seed |
| `npm run migration:lint` | Check migration files for security anti-patterns |
| `npm run types:verify` | Verify `lib/supabase/types.ts` is consistent with migrations |
| `npm run secrets:scan` | Scan staged files for secret patterns (also runs as pre-commit hook) |
| `npm run secrets:scan-all` | Scan all tracked files for secret patterns |
| `npm run bench:compare` | Compare a new benchmark run against the committed baseline |
| `npm run bundle:check` | Verify Next.js bundle stays within budget |
| `npm run hooks:install` | Configure git to use `.githooks/` (one-time per clone) |
| `npm run sbom` | Generate a software bill of materials |
| `npm run release:verify-gate` | Verify all release-gate evidence is present |

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
   * **Why**: `supabase-js`'s generic type checking requires the database schema to extend `Record<string, GenericTable>`. TypeScript's structural `extends` check only recognizes plain object `type` aliases as satisfying index signatures.
   * **The Risk**: If you use an `interface` (even deep inside nested types like emergency contacts or custom row models), the database query result types will **silently collapse to `never`** without any compilation error at the `Database` declaration. The error will only manifest downstream at `.from(...).select(...)` calls, making it hard to debug.

### 4. Verify Types Are In Sync (required step after every migration)

After updating `lib/supabase/types.ts`, run the types verification script to confirm it is consistent with the current migrations:

```bash
node scripts/verify-supabase-types.mjs
# or
npm run types:verify
```

This script checks that:
- Every public table defined in a migration has a corresponding entry in `lib/supabase/types.ts`.
- Every column from `CREATE TABLE` and `ALTER TABLE … ADD COLUMN` statements is referenced in the types file.
- (Local-only) No migration file is newer than `lib/supabase/types.ts`.

**CI fails with a clear message if the check does not pass.** If you see the failure locally, update `lib/supabase/types.ts` to match the migrations and re-run `npm run types:verify` before pushing.

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

## Secret Scanning

Lafiya runs a lightweight secret-pattern scan on every CI push and pull request (`scripts/scan-secrets.mjs`). The same script runs as a pre-commit hook when you install it with `npm run hooks:install`.

It catches common accidental credential commits: JWTs, private keys, AWS access keys, Stellar secret keys, Google API keys, and hardcoded password literals.

**To install the pre-commit hook** (one-time per clone):
```bash
npm run hooks:install
```

**To scan all tracked files manually:**
```bash
npm run secrets:scan-all
```

**False positives:** Add `// scan-secrets-ignore` (or `# scan-secrets-ignore`) as a comment on the specific line to suppress it. This is intentionally narrow — suppress a line only when you are certain it contains no real secret.

> This scan complements, and does not replace, GitHub's own secret scanning. Rotate any credential that was accidentally staged even if this script doesn't catch it.

---

## Pull Request Expectations & Checklist

Every Pull Request must be verified before merging. Please ensure the following checklist is completed:

### 1. Build and Quality Checks
Run the following verification pipeline locally:
```bash
npm run lint && npm run typecheck && npm test && npm run build
```
* **Linting**: No ESLint/Prettier warnings or errors.
* **Typechecking**: No TypeScript errors.
* **Unit/Component Tests**: All unit/component tests in `tests/` pass.
* **Build**: The Next.js production build completes without warnings.

### 2. Integration & RLS/RPC Tests
Ensure your local Supabase instance is running and verify database-specific behavior:
```bash
npx supabase start
npm run test:integration
```
* Every schema change (e.g., changes to Row-Level Security (RLS) policies or Postgres functions) **must** have a corresponding integration test in `tests/integration/`.

### 3. Checklist Summary
Before hitting submit on your PR:
- [ ] Code builds, lints, and passes type-checking.
- [ ] Unit and component tests pass.
- [ ] Integration tests pass against a running local Supabase.
- [ ] If a database migration was added, the hand-authored types in `lib/supabase/types.ts` were updated as `type` aliases.
- [ ] `npm run types:verify` passes (types are consistent with migrations).
- [ ] `npm run secrets:scan-all` passes (no secret patterns found in tracked files).
- [ ] You have declared whether this PR impacts a shared cross-repo contract.
