# Scheduled jobs

Schedules are defined as code in [`lib/ops/schedules.json`](../../lib/ops/schedules.json)
(Issue #693). Each entry records the route, cron expression, owner, runtime
budget (`maxDurationSeconds`), idempotency guarantee and the staleness budget
(`maxStalenessSeconds`) used for missed-run detection. Routes that are not
scheduled (e.g. the readiness probe) are listed with `"manualOnly": true` and
a `reason`.

## Generating platform config

```bash
npm run schedules:generate   # rewrites vercel.json crons + function maxDuration
npm run schedules:check      # CI: fails on drift or an unregistered route
```

`schedules:check` runs in CI and fails when:

- a `route.ts` under `app/api/internal` or `app/api/outbox` has no manifest entry;
- a manifest entry is missing its owner, schedule or runtime budget;
- `vercel.json` differs from what the manifest generates (dashboard-only edits
  are not allowed — change the manifest and regenerate).

## Detecting a missed run

Every job writes a heartbeat row to `public.job_leases.last_success_at` when a
run succeeds: leased jobs (payout / verification indexers, Issue #694) via
`release_job_lease`, other jobs via `record_job_success`.

`GET /api/internal/readiness` reports `components.scheduledJobs.<name>` with
`lastSuccessAgeSeconds` and a status:

| status      | meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `ok`        | last success is within `maxStalenessSeconds`                    |
| `stale`     | last success is older than `maxStalenessSeconds` — page on-call |
| `never_run` | no successful run has been recorded yet                         |
| `unknown`   | the heartbeat table could not be read                           |

Staleness is informational and does not fail readiness, so a stuck cron never
takes the app out of rotation.

## Job leases and the reaper

Long-running jobs hold a lease (`acquire_job_lease`, TTL default 120s) renewed
by heartbeats every TTL/3. A crashed runner's lease expires after its TTL; the
next invocation reaps it (`reap_expired_job_leases`) and takes over, logging a
`job_lease.takeover` warning. `jobLeaseMetrics` exposes the takeover count and
the last lease-held duration per job.
