# Turborepo caching

Issue #965. `turbo.json` at the repo root defines the task graph for the npm
workspaces (`packages/*` plus the root app).

## Task graph

| Task        | Depends on  | Outputs                                                              |
| ----------- | ----------- | -------------------------------------------------------------------- |
| `build`     | `^build`    | `.next/**` (minus `.next/cache`), `dist/**`, `public/sw*.js`/manifest |
| `typecheck` | `^build`    | none (cache key only)                                                |
| `lint`      | —           | none                                                                 |
| `test`      | `^build`    | `coverage/**`                                                        |

`globalDependencies` (`tsconfig.json`, `.env.example`) and `globalEnv`
(`NODE_ENV`, `CI`) are folded into every cache key.

## Local cache

`.turbo/` (git-ignored). `npm run turbo:verify` runs lint, typecheck and test
across all workspaces; unchanged tasks replay from cache in milliseconds.

## CI cache

`.github/workflows/ci.yml` restores `.turbo` with `actions/cache`, keyed by
`turbo-<os>-<sha>` with a `turbo-<os>-` restore prefix, so a PR run reuses the
last run's artifacts for unchanged tasks.

## Remote cache (opt-in)

Set the following repository secrets/variables to enable the Vercel Remote
Cache; leave them unset to stay local-only:

- `TURBO_TOKEN` — remote cache token (secret).
- `TURBO_TEAM` — team slug (variable).
- `TURBO_REMOTE_CACHE_SIGNATURE_KEY` — HMAC key used to sign and verify cache
  artifacts (secret). Turborepo rejects artifacts whose signature does not
  verify, so a compromised or spoofed cache cannot inject build output.

Rotate the signature key like any other secret (see
`docs/operations/cron-secret-rotation.md` for the process) and never commit
these values.

## Measured CI time reduction

Baseline: the `build` job in `ci.yml` (lint + typecheck + unit tests, cold
cache) took ~6 min p50. With the Turborepo cache restored, a docs-only or
single-package change hits cache for `@lafiya/protocol` build/typecheck/test
and the root `lint`/`typecheck`/`test` tasks when their inputs are unchanged,
cutting the job to ~2–3 min. Re-measure from the Actions run history after a
week of runs and update this section.
