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

## Commit and Tag Signing

All commits that land on `main` and all release tags (`v*`) **must be signed**. Branch
protection on `main` requires verified signatures, and tag protection rules prevent
unsigned or mutable release tags. Unsigned commits are rejected at push time, and the
release workflow re-verifies tag signatures before publishing.

### Choosing a signing method

Use whichever of the following you prefer — all are accepted:

- **Sigstore gitsign** (keyless, no long-lived keys)
- **SSH signing** (Git 2.34+)
- **GPG signing**

### Sigstore gitsign

1. Install gitsign (see the [gitsign docs](https://github.com/sigstore/gitsign)).
2. Configure Git to use it:

   ```bash
   git config --global gpg.format x509
   git config --global gpg.x509.program gitsign
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true
   ```

3. The first signed commit opens a browser for OIDC authentication.

### SSH signing

1. Generate (or reuse) an SSH key, e.g. `ssh-keygen -t ed25519 -C "you@example.com"`.
2. Upload the **public** key to your forge account as a *signing* key.
3. Configure Git:

   ```bash
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519.pub
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true
   ```

### GPG signing

1. Generate a key: `gpg --full-generate-key` (RSA 4096 or Ed25519 recommended).
2. Find the key ID: `gpg --list-secret-keys --keyid-format=long`.
3. Upload the public key to your forge account.
4. Configure Git:

   ```bash
   git config --global user.signingkey <KEY_ID>
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true
   ```

### Verifying signatures locally

```bash
# Show the signature status of recent commits
git log --show-signature -n 5

# Verify a specific release tag
git tag -v v1.2.3
```

A valid signature shows `Good signature` (GPG/SSH) or a verified Sigstore identity.
Unsigned commits show `No signature` and will be rejected by branch protection.

### CI verification

The release workflow (`.github/workflows/`) verifies that every release tag is signed
by an allowed maintainer identity before building or publishing artifacts. If you are
cutting a release, make sure the tag is signed (`git tag -s v1.2.3 -m "v1.2.3"`).

## Pull Requests

- Reference the issue you are resolving in the PR description.
- Explain any privacy-relevant decision (never log, persist, or send PHI or capability
tokens to third parties).
- Keep the diff surgical; avoid unrelated refactors.

## Code of Conduct

Be respectful and constructive. We are all here to build something useful together.
