# CI sharding and duration budget

Issue #777. `.github/workflows/ci-sharded.yml` splits the slowest suites
across matrix runners and merges their output.

## Layout

| Job               | Shards                                                  | Output                                                                                                      |
| ----------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `unit`            | 4 × `vitest run --shard=i/4 --reporter=blob --coverage` | `.vitest/blob` artifacts                                                                                    |
| `unit-merge`      | 1                                                       | `vitest --merge-reports --coverage` → `coverage/` (thresholds enforced, then `scripts/coverage-ratchet.ts`) |
| `e2e`             | 3 × `playwright test --shard=i/3 --reporter=blob`       | `blob-report` artifacts                                                                                     |
| `e2e-merge`       | 1                                                       | merged HTML report artifact + flaky-test summary                                                            |
| `duration-budget` | 1                                                       | fails when the run exceeds the budget                                                                       |

Per-shard coverage thresholds are disabled; the merged coverage is checked
against the same `vitest.config.ts` thresholds and the ratchet baseline, so
merged numbers match an unsharded run (V8 coverage merges by hit counts).

## Test impact analysis (Issue #953)

The `impact` job runs `scripts/test-impact.mjs` before the suites and decides
what to run:

- **Pull requests**: Vitest runs only the tests that (transitively) import a
  changed source file, plus changed test files. Playwright runs only specs
  whose `page.goto()` routes match a changed route directory (e.g. a change
  under `app/(public)/card/` selects specs that visit `/card/...`).
- **Fallback to full suites**: any change to `package.json`,
  `package-lock.json`, `tsconfig*`, `vitest*`/`playwright`/`next` configs,
  `.github/`, `scripts/`, `supabase/`, `packages/`, test fixtures/helpers, or
  app-wide entry points (`proxy.ts`, `instrumentation.ts`, Sentry configs).
- **`main`, nightly and manual runs** always run the full suites.

The job writes `test-impact.json` (artifact, 7 days) and a summary table in
the `duration-budget` job. Escape rate is monitored by the nightly full run:
any test that fails on `main` but was skipped on a PR is visible in the
nightly run and the flaky-test summary.

## Caching

- npm: `actions/setup-node` cache keyed by `package-lock.json`.
- Playwright browsers: `~/.cache/ms-playwright` keyed by the installed
  `@playwright/test` version.
- Supabase images: `docker save` tarball keyed by `supabase/config.toml` and
  `package-lock.json`.

## Expected timings

|                 | Before (sequential) | After (sharded)                   |
| --------------- | ------------------- | --------------------------------- |
| Unit + coverage | ~8 min              | ~2.5 min per shard + ~1 min merge |
| Playwright e2e  | ~15 min             | ~5–6 min per shard + ~1 min merge |
| p50 wall clock  | ~25 min             | ~10 min                           |

The "before" figures are the sequential `integration` job in `ci.yml`;
re-measure from the Actions run history after a week of runs and update this
table.

## Budget

`CI_DURATION_BUDGET_MINUTES` (default 20) in `ci-sharded.yml`. The
`duration-budget` job writes the run duration to the job summary and fails
with an error annotation when the budget is exceeded, which alerts on
regression in the PR checks. Raise the budget only together with an update to
the timings above.

## Flaky tests

Playwright retries once in CI. `e2e-merge` scans the merged report for tests
whose status is `flaky` (failed, then passed on retry) across all shards and
lists them in the job summary with a warning annotation.
