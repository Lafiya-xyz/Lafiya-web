# Reproducible builds

Provenance (`supply-chain.yml`) says _where_ an artifact was built. This
check proves a deployed client bundle _corresponds to a commit_: anyone can
rebuild it and compare hashes.

## CI

`.github/workflows/reproducible-build.yml` builds the same commit twice in
clean checkouts at different absolute paths, hashes every file under
`.next/static` (the client assets served from `/_next/static`) and fails if
any path or SHA-256 differs.

## Sources of nondeterminism and fixes

| Source                  | Effect                                                              | Fix                                                                                                   |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Random Next.js build ID | `_next/static/<buildId>/_buildManifest.js` path differs every build | `generateBuildId` in `next.config.ts` uses `LAFIYA_BUILD_ID`, `VERCEL_GIT_COMMIT_SHA` or `GITHUB_SHA` |
| Absolute checkout path  | Paths embedded in chunks                                            | Caught by building at two paths; Next/Turbopack emit project-relative paths                           |
| `node_modules` drift    | Different dependency code                                           | `npm ci` from the lockfile in both builds                                                             |
| Telemetry / environment | Env-dependent output                                                | `NEXT_TELEMETRY_DISABLED=1` and identical public env in both builds                                   |

## Verifying a deployment

```bash
# Build <sha> in a clean worktree, then compare with the deployment's assets
node scripts/verify-reproducible-build.mjs verify --commit <sha> --url https://<preview>.vercel.app

# Or compare an existing local build
node scripts/verify-reproducible-build.mjs verify --url https://<preview>.vercel.app
```

The build must use the same public env (`NEXT_PUBLIC_*`) as the deployment,
because those values are inlined into client chunks.

## Known differences

- **Server output is not compared.** `.next/server` and trace files contain
  absolute paths and timing metadata; only client assets are in scope.
- **Sentry source maps.** With `SENTRY_AUTH_TOKEN` set, the Sentry plugin
  injects a per-release debug ID into client chunks. Rebuild with the same
  release (commit SHA) to match; builds without the token are unaffected.
- **`NEXT_PUBLIC_*` values** differ per environment, so a preview build only
  matches a local build using the preview's values.
