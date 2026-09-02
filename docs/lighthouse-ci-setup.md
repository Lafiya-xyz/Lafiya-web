# Lighthouse CI Performance Setup

## Summary

Added a Lighthouse CI job to `.github/workflows/ci.yml` that audits the public card page (`/card/[demo-id]`) against defined performance and accessibility budgets. The job runs after the existing build step, starts a local Supabase instance with the seeded demo profile, and fails the PR if any budget is violated.

## Files changed

- `package.json` — added `@lhci/cli` to devDependencies
- `.lighthouserc.json` — Lighthouse CI config with budgets
- `.github/workflows/ci.yml` — added `performance` job

## Why this matters

The public card page is the user-facing emergency info surface. Its value depends on loading quickly on low-end Android devices over poor connections. Without an automated budget, regressions (extra dependencies, unoptimized images, heavier font loads) accumulate silently until someone notices manually.

## What was added

### 1. Dependency

`@lhci/cli` was added to `devDependencies` so LHCI can run in CI without being part of the production bundle.

### 2. Lighthouse CI config (`.lighthouserc.json`)

The config targets the seeded demo card:

```
http://localhost:3000/card/11111111-1111-1111-1111-111111111111
```

Audit settings:

- Categories: `performance` + `accessibility`
- Form factor: mobile
- 3 runs per job (median score)
- Mobile Slow 4G throttling

Budgets (deliberately tight for this route and audience):

- Performance score: ≥ 0.85
- Accessibility score: ≥ 0.9
- LCP: ≤ 2500ms
- TBT: ≤ 200ms
- CLS: ≤ 0.1
- JS payload: ≤ 200KB
- Document payload: ≤ 50KB
- Total payload: ≤ 300KB

### 3. CI job (`.github/workflows/ci.yml`)

The new `performance` job:

- Depends on `test` (build already validated)
- Boots a local Supabase stack via `supabase/setup-cli@v1`
- Runs `supabase db reset` to apply migrations + `supabase/seed.sql` (the seeded demo patient)
- Builds the Next.js app
- Starts `next start` in the background and waits for the card route to respond
- Runs `lhci collect` then `lhci assert` against the config
- Tears down Supabase via `supabase stop` on completion or failure

Environment for the built app uses the real local Supabase values from `.env.test` (not the dummy build-time values), because the production server must actually fetch the seeded demo card at runtime.

## Acceptance criteria

- [x] Lighthouse CI job added, running against the public card route
- [x] Performance/accessibility budgets defined and enforced (PR fails on regression)
- [ ] Baseline numbers documented in the PR that introduces this

## Baseline documentation (for the PR author)

Run the performance job once and paste the first successful LHCI report here so the team has a reference point for tightening budgets later:

```
# Example output format
Performance: <score>
Accessibility: <score>
LCP: <value>
TBT: <value>
CLS: <value>
JS: <value>
Document: <value>
Total: <value>
```

Future work: tighten budgets after image optimization, print styles, and offline caching land.
