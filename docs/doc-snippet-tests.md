# Doc snippet tests

`npm run docs:snippets` (`scripts/run-doc-snippets.mjs`) executes annotated
code blocks in `docs/` so examples don't rot. CI runs it with
`--require-sql` against a throwaway Postgres (`.github/workflows/doc-snippets.yml`).

## Annotating a block

Put an HTML comment on the line above the fence (it does not render on
GitHub). A blank line in between is allowed.

````md
<!-- doctest -->

```sql
select 1;
```
````

| Annotation                | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `<!-- doctest -->`        | Run the block in its language's default mode.                |
| `<!-- doctest syntax -->` | Parse only. For fragments that reference undeclared context. |
| `<!-- doctest exec -->`   | Shell only: actually execute the block (sandboxed).          |

Unannotated blocks are ignored.

## Languages

| Language            | Default mode                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ts` / `typescript` | Type-checked against the repo `tsconfig.json` (`@/` imports resolve).                                                                                                                                               |
| `json`              | `JSON.parse`.                                                                                                                                                                                                       |
| `env`               | Every non-comment line must be `KEY=value`.                                                                                                                                                                         |
| `sql`               | Run via `psql` against `$DOCTEST_DATABASE_URL`. Each file's blocks run in order in one transaction that is always rolled back, after `scripts/doctest-sql-prelude.sql`. Skipped locally when the variable is unset. |
| `bash` / `sh`       | `bash -n` syntax check plus the command allowlist. Executed only with `exec`.                                                                                                                                       |

## Sandbox and allowlist

- Every command a shell block invokes (including inside `$(…)`, pipes and
  `&&` chains) must be in `SHELL_ALLOWLIST` in the runner. Anything else is
  refused, in every mode — extend the list deliberately in review.
- `exec` blocks run in a fresh temp directory with an empty environment
  (only `PATH` and `HOME`, so no secrets) under `unshare --net` (no network).
- SQL runs inside `begin … rollback`; nothing persists.

## Limits

- TypeScript snippets that reference variables defined elsewhere in the page
  can't be type-checked — use `syntax`.
- SQL that depends on Supabase objects needs a stand-in in the prelude; keep
  it minimal. Blocks with placeholders like `'<user-id>'` can't run — leave
  them unannotated.
- Commands that need a running app, Supabase CLI or network (`npm run build`,
  `supabase start`, `k6`) can only be syntax/allowlist checked.
- Output comparison is not supported yet; a block passes if it exits cleanly.
