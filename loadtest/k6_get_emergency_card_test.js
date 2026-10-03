// ---------------------------------------------------------------------------
// k6 load-test harness for the public emergency card page (/card/[id]).
//
// Two scenarios, run sequentially:
//
//   cache_hit  — All VUs repeatedly hit ONE card ID.  After the first
//                request, Next.js ISR (revalidate = 60) serves the cached
//                HTML.  This measures the *best-case* response time a
//                responder sees when scanning a card that was recently
//                accessed by someone else.
//
//   cache_miss — Each VU picks a random card ID from a pool of 500.  Most
//                requests miss the ISR cache and force a Supabase RPC round-
//                trip.  This measures *worst-case / cold-cache* latency
//                under realistic multi-patient load.
//
// Connection-pooling proof (issue #584):
//   The cache_miss scenario is the DB-bound path.  Every request that misses
//   ISR goes through supabase-js → PostgREST → Supavisor (transaction mode)
//   → Postgres.  To prove the pooler holds under saturation we snapshot
//   pg_stat_activity via the Supabase Management API (or a read-only
//   `pg_stat_activity` RPC) at a fixed interval and record the observed
//   connection counts as k6 metrics.  Set SUPABASE_MGMT_TOKEN and
//   SUPABASE_PROJECT_REF to enable snapshots; without them the harness still
//   runs and simply skips the connection metrics.
//
// Usage:
//   BASE_URL=http://localhost:3000 k6 run loadtest/k6_get_emergency_card_test.js
//
// Environment variables:
//   BASE_URL             — origin of the running Next.js app  (required)
//   CONCURRENCY          — target VUs per scenario             (default: 500)
//   DURATION             — steady-state duration per scenario  (default: "1m")
//   SUPABASE_MGMT_TOKEN  — Supabase Management API token      (optional)
//   SUPABASE_PROJECT_REF — Supabase project ref               (optional)
//   PG_SNAPSHOT_INTERVAL — seconds between snapshots           (default: 5)
// ---------------------------------------------------------------------------

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Rate, Trend, Gauge } from "k6/metrics";

// ── Custom metrics ──────────────────────────────────────────────────────────

const errorRate = new Rate("errors");

// Per-scenario latency trends (k6 built-in http_req_duration is global;
// these let us set separate thresholds and report independently).
const cacheHitDuration = new Trend("cache_hit_duration", true);
const cacheMissDuration = new Trend("cache_miss_duration", true);
const cacheHitErrors = new Rate("cache_hit_errors");
const cacheMissErrors = new Rate("cache_miss_errors");

// Connection-pool metrics sampled from pg_stat_activity snapshots.
// `pg_connections` is the total backend count; `pg_active_connections` is the
// subset currently executing a query.  Both are gauges so the k6 summary
// reports min/avg/max across the run.
const pgConnections = new Gauge("pg_connections");
const pgActiveConnections = new Gauge("pg_active_connections");
const pgSnapshotErrors = new Rate("pg_snapshot_errors");

// ── Shared data ─────────────────────────────────────────────────────────────

const cardIds = new SharedArray("card ids", function () {
  const raw = open("./card_ids.txt");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((id) => id.length > 0);
});

if (cardIds.length === 0) {
  throw new Error(
    "loadtest/card_ids.txt is empty or missing — run the seed script first.",
  );
}

// Pick one fixed card ID for the cache-hit scenario.
const fixedCardId = cardIds[0];

// ── Options ─────────────────────────────────────────────────────────────────

const vus = Number(__ENV.CONCURRENCY) || 500;
const duration = __ENV.DURATION || "1m";

// Snapshot cadence for pg_stat_activity sampling (seconds).
const snapshotInterval = Number(__ENV.PG_SNAPSHOT_INTERVAL) || 5;

// Total wall-clock length of the cache_hit scenario (ramp + steady + ramp).
const cacheHitTotalSeconds = 30 + parseDurationSeconds(duration);

// cache_miss starts after cache_hit + 30 s cool-down so ISR entries from
// scenario A have a chance to expire and we avoid cross-contamination.
const cacheMissStartSeconds = cacheHitTotalSeconds + 30;

// Total run length, used to schedule the pg_stat_activity sampler.
const totalRunSeconds = cacheMissStartSeconds + 30 + parseDurationSeconds(duration);

export const options = {
  scenarios: {
    // Scenario A: repeated hits to the SAME card (cache-hit dominated).
    cache_hit: {
      executor: "ramping-vus",
      exec: "cacheHitScenario",
      startVUs: 0,
      stages: [
        { duration: "15s", target: vus },
        { duration: duration, target: vus },
        { duration: "15s", target: 0 },
      ],
      tags: { scenario: "cache_hit" },
    },

    // Scenario B: hits spread across many distinct cards (cache-miss / DB-bound).
    cache_miss: {
      executor: "ramping-vus",
      exec: "cacheMissScenario",
      startVUs: 0,
      stages: [
        { duration: "15s", target: vus },
        { duration: duration, target: vus },
        { duration: "15s", target: 0 },
      ],
      startTime: `${cacheMissStartSeconds}s`,
      tags: { scenario: "cache_miss" },
    },

    // Scenario C: background sampler that records pg_stat_activity connection
    // counts while the DB-bound scenario is running.  Runs as a single VU so
    // it does not add meaningful load of its own.
    pg_snapshot: {
      executor: "constant-vus",
      exec: "pgSnapshotScenario",
      vus: 1,
      duration: `${totalRunSeconds}s`,
      tags: { scenario: "pg_snapshot" },
    },
  },

  thresholds: {
    // Global SLOs
    errors: ["rate<0.01"],

    // Cache-hit: ISR-served responses should be very fast.
    cache_hit_duration: ["p(50)<200", "p(95)<500", "p(99)<800"],
    cache_hit_errors: ["rate<0.01"],

    // Cache-miss: includes DB round-trip; allowed to be slower.
    cache_miss_duration: ["p(50)<500", "p(95)<1500", "p(99)<2500"],
    cache_miss_errors: ["rate<0.01"],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a k6 duration string like "1m", "2m30s", "90s" into total seconds.
 * Only supports minutes and seconds — sufficient for this harness.
 */
function parseDurationSeconds(dur) {
  let total = 0;
  const minMatch = dur.match(/(\d+)m/);
  const secMatch = dur.match(/(\d+)s/);
  if (minMatch) total += parseInt(minMatch[1], 10) * 60;
  if (secMatch) total += parseInt(secMatch[1], 10);
  return total || 60; // fallback to 60 s
}

function makeRequest(cardId) {
  // Correct path: (public) is a Next.js route group — excluded from the URL.
  const url = `${__ENV.BASE_URL}/card/${cardId}`;
  return http.get(url, { tags: { name: "GET /card/[id]" } });
}

// ── Scenario functions ──────────────────────────────────────────────────────

export function cacheHitScenario() {
  const res = makeRequest(fixedCardId);
  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "body contains patient name": (r) =>
      r.body && r.body.includes("Load Test User"),
  });

  cacheHitDuration.add(res.timings.duration);
  cacheHitErrors.add(!ok);
  errorRate.add(!ok);

  sleep(0.5 + Math.random() * 0.5); // 0.5–1 s think time
}

export function cacheMissScenario() {
  // Pick a random card from the full pool — with 500 cards and 500 VUs,
  // most requests will be cache misses within any 60 s ISR window.
  const id = cardIds[Math.floor(Math.random() * cardIds.length)];
  const res = makeRequest(id);
  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "body contains patient name": (r) =>
      r.body && r.body.includes("Load Test User"),
  });

  cacheMissDuration.add(res.timings.duration);
  cacheMissErrors.add(!ok);
  errorRate.add(!ok);

  sleep(0.5 + Math.random() * 0.5);
}

// ── Connection-pool sampler ─────────────────────────────────────────────────

/**
 * Sample pg_stat_activity through the Supabase Management API and record the
 * observed connection counts.  This is the evidence that Supavisor (in
 * transaction mode) keeps backend connections bounded while the DB-bound
 * scenario runs at the target concurrency.
 *
 * The query counts total backends and the subset that are actively running a
 * query.  It never selects query text or any patient data — only aggregate
 * counts — so no PHI leaves the database.
 */
export function pgSnapshotScenario() {
  const token = __ENV.SUPABASE_MGMT_TOKEN;
  const ref = __ENV.SUPABASE_PROJECT_REF;

  // Without credentials we cannot snapshot; skip quietly so the harness still
  // runs in local/CI environments that lack Management API access.
  if (!token || !ref) {
    sleep(snapshotInterval);
    return;
  }

  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  const body = JSON.stringify({
    query:
      "select count(*)::int as total, " +
      "count(*) filter (where state = 'active')::int as active " +
      "from pg_stat_activity where backend_type = 'client backend'",
  });

  const res = http.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    tags: { name: "POST pg_stat_activity" },
  });

  const ok = check(res, {
    "snapshot status is 200": (r) => r.status === 200,
  });
  pgSnapshotErrors.add(!ok);

  if (ok) {
    try {
      const rows = res.json();
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row && typeof row.total === "number") {
        pgConnections.add(row.total);
        pgActiveConnections.add(row.active || 0);
      }
    } catch (e) {
      pgSnapshotErrors.add(true);
    }
  }

  sleep(snapshotInterval);
}
