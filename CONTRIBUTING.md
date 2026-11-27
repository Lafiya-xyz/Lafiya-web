# Contributing

Thanks for your interest in contributing! This document explains how to get set up, run the project locally, and submit changes.

## Getting Started

1. Fork and clone the repository.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env.local` and fill in the required values.
4. Start the dev server with `npm run dev`.

## Development Workflow

- Create a feature branch off `main`.
- Keep changes focused and scoped to a single issue.
- Run the checks below before opening a pull request.

## Checks

```bash
npm run lint
npm run typecheck
npm test
```

## Task orchestration (Turborepo)

The repo is an npm workspace (`packages/*`) orchestrated by
[Turborepo](https://turbo.build). `turbo.json` defines the `build`, `typecheck`,
`lint` and `test` task graph; each task runs per workspace and is skipped when
its inputs (source files, `package-lock.json`, `tsconfig.json`, env vars listed
in `globalEnv`) are unchanged.

```bash
npm run turbo:verify     # lint + typecheck + test across all workspaces
npm run turbo:build      # build every workspace in dependency order
npm run turbo -- run test --filter=@lafiya/protocol
```

- Local cache lives in `.turbo/` (git-ignored). Use `--force` to bypass it.
- CI restores `.turbo` via `actions/cache` in `.github/workflows/ci.yml`, so
  unchanged tasks are cache hits on repeat runs.
- Remote caching is opt-in: set `TURBO_TOKEN` and `TURBO_TEAM` (see
  `docs/operations/turborepo-caching.md`). Never commit these values.
- `npm run lint`, `npm run typecheck` and `npm test` still work and run the
  root workspace only; prefer the `turbo:*` scripts when touching
  `packages/`.

## Database Tests (pgTAP)

The security-critical PL/pgSQL functions (for example `rate_limit_record_failure`,
`frequency_limit_check_and_increment`, `consume_emergency_capability`,
`save_record_revision`, and `update_disclosure_policy`) are covered by a first-class
pgTAP test suite under `supabase/tests/`. These tests assert behaviour, permissions,
`SECURITY DEFINER` settings, and RLS policy existence directly in SQL, so they run fast
and close to the code.

### Running the suite locally

1. Start the local Supabase stack:

   ```bash
   supabase start
   ```

2. Run the database tests:

   ```bash
   supabase test db
   ```

The `pgtap` extension is enabled for local and test environments only (see
`supabase/migrations/`). It is never enabled in production.

### Writing tests

- Add new files as `supabase/tests/<name>.test.sql`.
- Use `plan(<n>)` and `finish()` to bracket each file.
- Cover the lockout backoff schedule, window roll-over, capability consumption at
  budget/expiry boundaries, revision monotonicity, and grants (for example, `anon`
  cannot execute privileged functions).
- Every `SECURITY DEFINER` function must have a test asserting its `search_path`
  setting and its role grants.

### CI

CI runs `supabase test db` on every pull request that touches `supabase/`. A failing
assertion fails the job, so regressions in the security-critical SQL are caught before
merge.

## Pull Requests

- Reference the issue you are resolving in the PR description.
- Explain any privacy-relevant decision (never log, persist, or send PHI or capability
tokens to third parties).
- Keep the diff surgical; avoid unrelated refactors.

## Code of Conduct

Be respectful and constructive. We are all here to build something useful together.
