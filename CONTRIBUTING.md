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

## `contracts/`, `lib/stellar/`, and `lib/chw-protocol/`: what lives where

This repo has three overlapping-sounding pieces related to the attestation/Soroban layer, plus a fully separate `lafiya-contracts` repo. None of them duplicate each other — here's the boundary:

### `contracts/` (this repo) — shared interface definitions, not on-chain code

`contracts/` contains **JSON Schema documents** (`chw-attestation-protocol-v1.json`, `record-canonicalization-v1.json`, and their `.schema.json` validators). These define the *wire format* that this web app and `lafiya-contracts` must agree on — e.g. the exact shape of a canonicalized record hash input, or the CHW attestation protocol envelope. They are versioned, language-agnostic contract documents, consumed by this repo's TypeScript at build/runtime for validation.

**They contain no executable contract logic and nothing here runs on-chain.** The actual Soroban smart contracts — the Rust code that gets compiled to Wasm and deployed to the Stellar network — live entirely in the separate [`lafiya-contracts`](https://github.com/lafiya-xyz/lafiya-contracts) repo. If you change a schema in `contracts/`, the corresponding Rust struct in `lafiya-contracts` must change too (see "Shared Contracts" above); if you're looking for the code that actually executes when an attestation is recorded, it isn't in this repo at all.

### `lib/stellar/` — this app's client to the chain

`lib/stellar/` is ordinary TypeScript that runs in this app (server or client, never on-chain). It's the boundary code that talks *to* the deployed Soroban contracts and to Horizon:

- `attestation.ts` — calls `simulateTransaction` against the deployed attestation registry's `get_attestation` function (read-only) and exposes the result with the shape the real Soroban call has.
- `chw-identity.ts` — derives/validates Stellar addresses for health workers.
- `payout-indexer/`, `verification-indexer/` — off-chain indexers that poll Horizon/Soroban RPC and mirror on-chain payment and attestation state into Supabase, so the app doesn't have to hit RPC on every page load.

Nothing in `lib/stellar/` is deployed to the network; it only reads from and constructs calls to contracts that live in `lafiya-contracts`.

### `lib/chw-protocol/` — protocol config and guardrails, also off-chain

`lib/chw-protocol/` holds the CHW protocol's deployment configuration and business rules as plain TypeScript: `config.ts` resolves the deployment guard (`LAFIYA_DEPLOYMENT_ENV`, `ATTESTATION_MODE`, epoch ID, signing key), `types.ts` and `intent.ts` define and validate the shape of a CHW registration/attestation intent before it's sent, and `trust.ts` encodes the allowlist/trust rules this app applies client-side. This is policy and validation logic for *this app's* use of the protocol — it does not execute on-chain and is distinct from both the wire-format schemas in `contracts/` and the RPC boundary code in `lib/stellar/`.

**In short:** `contracts/` = shared data-format specs (this repo mirrors, doesn't own or execute); `lib/stellar/` = this app's RPC/indexing boundary to already-deployed contracts; `lib/chw-protocol/` = this app's own config/validation logic layered on top; `lafiya-contracts` (separate repo) = the actual on-chain Soroban source.

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
- [ ] You have declared whether this PR impacts a shared cross-repo contract.
