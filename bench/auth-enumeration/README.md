# Auth enumeration timing benchmark

Issue #527 requires that sign-up and sign-in not reveal whether an email has
a Lafiya account, through either the response body or the timing. The unit
tests in `app/(auth)/signup/actions.test.ts` and
`app/(auth)/signin/actions.test.ts` check that the bodies match. This harness
measures the timing.

## What it measures

For each flow (`signin`, `signup`) it interleaves 200 attempts (the default)
for an **existing** account and 200 for an **unknown** email. Every attempt
is wrapped in the same `withTimingFloor` padding the server actions use,
with the floors from [`lib/security/timing.ts`](../../lib/security/timing.ts).
The harness reports raw and padded p50/p95/p99 per class. It **fails** (exit
code 1) when the padded p95 difference between the classes is 50 ms or more.
It also warns when either class's raw p99 reaches the floor, which means the
floor is too low for that environment.

| Flow                      | Existing-account path                                                | Unknown-email path                                                |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `signin` (wrong password) | rate-limit check, GoTrue bcrypt compare, `rate_limit_record_failure` | rate-limit check, GoTrue lookup miss, `rate_limit_record_failure` |
| `signup`                  | GoTrue early return (existing user)                                  | GoTrue user creation, `consent_logs` insert, local sign-out       |

## Running it

```bash
# Padding mechanism only; no Supabase needed:
node bench/auth-enumeration/harness.mjs --mode simulate

# Against a local Supabase stack (keys as printed by `npm run db:start`):
npm run db:start
export NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key> SUPABASE_SERVICE_ROLE_KEY=<service_role key>
node bench/auth-enumeration/harness.mjs --flow signin --out results/<date>-live.json
```

Local GoTrue allows only 30 sign-in/sign-up requests per 5 minutes per IP.
Before a live run, temporarily raise the limit in `supabase/config.toml`, then
restart the stack with `npm run db:stop && npm run db:start`. Don't commit this
change:

```toml
[auth.rate_limit]
sign_in_sign_ups = 10000
```

The harness aborts on the first HTTP 429 instead of measuring rate-limited
responses. Synthetic `bench-*@example.com` users are deleted at the end of the
run. No patient data is used.

A full run of 200 samples per class takes about 7 minutes for `signin` (1 s
floor) and about 14 minutes for `signup` (2 s floor), because every attempt
is padded.

## Flags

| Flag          | Default  | Meaning                                                          |
| ------------- | -------- | ---------------------------------------------------------------- |
| `--mode`      | `live`   | `live` or `simulate`                                             |
| `--flow`      | `both`   | `signin`, `signup`, or `both`                                    |
| `--samples`   | `200`    | Attempts per class                                               |
| `--threshold` | `50`     | Maximum allowed padded p95 difference, in ms                     |
| `--out`       | _(none)_ | Also write the JSON report to this path, relative to this folder |

## Results

`results/` holds committed runs. `2026-09-30-simulate.json` checks the padding
against synthetic latency. For sign-in, the existing-account path is about
110 ms versus 25 ms for unknown emails. For sign-up the direction flips: the
new-account path is about 260 ms versus 40 ms for an existing email. Record
a `live` run from a staging-like environment before changing the floors.
