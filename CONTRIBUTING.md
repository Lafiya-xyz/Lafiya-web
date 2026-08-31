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

## Common Commands

All frequently-used commands have a named `npm run` script so you never need to remember the raw multi-part form.

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Build the production Next.js bundle |
| `npm start` | Serve a previously built production bundle |
| `npm test` | Run unit and component tests (Vitest, jsdom) |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run test:integration` | Run Supabase RLS/RPC integration tests (requires `npm run db:start` first) |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run lint` | Run ESLint (zero warnings allowed) |
| `npm run typecheck` | Run TypeScript type-checker without emitting |
| `npm run format` | Auto-format all files with Prettier |
| `npm run format:check` | Check formatting without writing changes |
| `npm run migration:lint` | Lint Supabase migration files |
| `npm run migration:new` | Create a new Supabase migration file (pass a name after `--`) |
| `npm run db:start` | Start the local Supabase stack (`supabase start`) |
| `npm run db:stop` | Stop the local Supabase stack (`supabase stop`) |
| `npm run db:reset` | Reset and re-seed the local database (`supabase db reset`) |
| `npm run types:check` | Verify `lib/supabase/types.ts` is in sync with current migrations |
| `npm run secrets:scan` | Scan staged/changed files for accidentally committed secrets |
| `npm run bench` | Run the Soroban RPC/Horizon provider benchmark harness |
| `npm run bench:compare` | Diff a benchmark result file against the committed baseline |
| `npm run bundle:check` | Check Next.js production bundle sizes against budgets |
| `npm run ci:check-action-pins` | Verify all GitHub Actions are pinned to full SHA digests |
| `npm run ci:check-clean-worktree` | Assert the git worktree is clean (no uncommitted changes) |
| `npm run ci:check-all` | Run the full local CI pipeline in one command |
| `npm run sbom` | Generate a software bill of materials |
| `npm run release:verify-gate` | Verify the release gate before a production deploy |

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
3. **Verify sync before committing** by running:
   ```bash
   npm run types:check
   ```
   This script scans every `CREATE TABLE` and `CREATE TYPE … AS ENUM` in `supabase/migrations/` and confirms each one has a matching entry in `lib/supabase/types.ts`. CI runs this check on every push and PR — if it fails you will see a clear message listing exactly which tables or enums are missing and how to fix them.

---

## Secret Scanning

A lightweight secret-pattern scanner runs automatically as a **pre-commit hook** and as a **CI step** to catch accidental credential commits before they reach the remote.

### What it checks
Common patterns including API keys, PEM private keys, Supabase service role JWTs (production-length), Stellar secret keys (`S…`, 56-char base32), AWS access keys, GitHub tokens, and Stripe secret keys.

### Pre-commit hook
The hook is installed automatically when you run `npm install` (via the `prepare` script, which sets `git config core.hooksPath .githooks`). After that, every `git commit` automatically scans staged files. To install manually:
```bash
git config core.hooksPath .githooks
```

### Running manually
```bash
npm run secrets:scan           # scan staged files (same as pre-commit)
npm run secrets:scan -- --all  # scan all tracked files (CI mode)
```

### Suppressing a known false positive
If a line is a genuine test fixture or placeholder, add a suppression hint on the same line:
```bash
MY_KEY=fake-key-for-testing   # dummy
```
Words that suppress: `dummy`, `placeholder`, `example`, `replace-me`, `fake`, `demo`, `test-only`.

### Skipped files
`.env.test`, `.env.example`, `package-lock.json`, and CI workflow files (which intentionally contain the well-known public Supabase demo JWTs) are excluded from scanning.

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

## Pull Request Expectations & Checklist

Every Pull Request must be verified before merging. Please ensure the following checklist is completed:

### 1. Build and Quality Checks
Run the following verification pipeline locally:
```bash
npm run ci:check-all
```
This runs lint, typecheck, migration lint, types sync check, secrets scan, action-pin check, unit tests, build, and clean-worktree check in sequence. You can also run steps individually:
* **Linting**: `npm run lint` — no ESLint/Prettier warnings or errors.
* **Typechecking**: `npm run typecheck` — no TypeScript errors.
* **Unit/Component Tests**: `npm test` — all unit/component tests pass.
* **Build**: `npm run build` — the Next.js production build completes without warnings.

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
- [ ] If a database migration was added, the hand-authored types in `lib/supabase/types.ts` were updated as `type` aliases **and** `npm run types:check` passes.
- [ ] `npm run secrets:scan` passes (no accidental credentials committed).
- [ ] You have declared whether this PR impacts a shared cross-repo contract.
