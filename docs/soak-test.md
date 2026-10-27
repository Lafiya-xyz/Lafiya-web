# Soak test: memory and handle growth

Issue #785. `loadtest/memory.soak.ts` (run with `npm run test:soak`) drives
the in-process handlers that keep module-level state with a high-cardinality
traffic mix (random client IPs, random session ids, distinct password
prefixes) and samples heap-after-GC, active handles and event-loop lag p99.

- **Fails when** the least-squares heap trend over the post-warm-up window
  (last 80% of samples) projects more than `SOAK_HEAP_GROWTH_LIMIT_MB`
  (default 32) over the run, or active handles grow by more than
  `SOAK_HANDLE_GROWTH_LIMIT` (default 20).
- **Schedule:** `.github/workflows/soak.yml` runs nightly for 30 minutes
  (`workflow_dispatch` accepts 30-60). Trend charts (`heap.svg`,
  `handles.svg`, `event-loop-lag.svg`), raw `samples.csv` and `summary.json`
  are uploaded as the `soak-trends` artifact.
- **Bounds inventory:** `tests/unit/module-collections.test.ts` enumerates
  every module-level / class-field `Map`/`Set` under `app/` and `lib/` and
  fails until each has a documented bound.

## Leaks found and fixed

| Structure                                                | Problem                                                      | Fix                                            |
| -------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `app/api/vitals/route.ts` `aggregationStore`             | Every sample was retained forever, plus a new bucket per day | `BoundedMap(256)` and 1,000 samples per bucket |
| `app/api/vitals/route.ts` `rateLimitStore`               | One entry per client IP, never deleted                       | `BoundedMap(10_000)`                           |
| `app/api/e/route.ts` `rateBuckets`                       | One entry per daily IP hash, never deleted                   | `BoundedMap(10_000)`                           |
| `app/api/chw/sponsor/route.ts` `quotaLedger`             | One entry per CHW, never deleted                             | `BoundedMap(10_000)`                           |
| `lib/stellar/sponsor-policy.ts` quota `counts`           | Keyed by day and CHW, grows every day                        | `BoundedMap(10_000)`                           |
| `lib/stellar/payout-indexer/sources.ts` `trustlineCache` | TTL checked on read, expired entries never evicted           | `BoundedMap(10_000)`                           |

The vitals and analytics leak was confirmed by the soak itself: with the
original unbounded maps, a 30 s run projects about 36 MB of heap growth and
fails. With the bounds in place, a 60 s run (1.3 M operations) projects about
-1 MB. `lib/sessions/throttle.ts` and `lib/security/breached-password.ts`
were already LRU-bounded, and `lib/flags.ts` is keyed by the finite
`FlagKey` union.
