// ---------------------------------------------------------------------------
// Auth account-enumeration timing benchmark (#527).
//
// Measures whether a caller can tell "this email has a Lafiya account" from
// "it does not" by timing sign-in or sign-up. For each flow it interleaves
// requests for an EXISTING account and an UNKNOWN email, wraps each attempt
// in the exact padding the server actions use (withTimingFloor and the floors
// from lib/security/timing.ts), and reports per-class percentiles. It fails
// when the padded p95 difference between the classes is 50 ms or more.
//
// Modes:
//   --mode live      (default) Replays the server actions' Supabase calls
//                    against a local stack: GoTrue sign-in/sign-up plus the
//                    same rate-limit/consent/sign-out work the actions do.
//   --mode simulate  No Supabase needed. Replays synthetic latency
//                    distributions (the existing-account path is slower,
//                    like bcrypt) through the same padding. It validates the
//                    padding mechanism only, not real Supabase latency.
//
// Usage:
//   node bench/auth-enumeration/harness.mjs
//   node bench/auth-enumeration/harness.mjs --flow signin --samples 200
//   node bench/auth-enumeration/harness.mjs --mode simulate --out results/x.json
//
// Live mode needs `npm run db:start`. Local GoTrue allows only 30
// sign-in/sign-up requests per 5 minutes per IP ([auth.rate_limit]
// sign_in_sign_ups in supabase/config.toml). Raise it for the run; see
// README.md. The harness aborts on the first HTTP 429 rather than measuring
// rate-limit responses.
//
// No patient data is used: accounts are synthetic bench-*@example.com users
// and are deleted when the run ends.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SIGN_IN_TIMING_FLOOR_MS,
  SIGN_UP_TIMING_FLOOR_MS,
  withTimingFloor,
} from "../../lib/security/timing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const MODE = argValue("--mode", "live");
const FLOW = argValue("--flow", "both");
const SAMPLES = Number(argValue("--samples", "200"));
const THRESHOLD_MS = Number(argValue("--threshold", "50"));
const OUT_PATH = argValue("--out", "");

// Live mode reads the local stack's URL and keys from the environment, e.g.
// `set -a; source .env.test; set +a` or the values `npm run db:start` prints.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const PASSWORD = "bench-password-123456"; // scan-secrets-ignore (synthetic bench user)
const RUN_ID = Date.now().toString(36);
let counter = 0;
const benchEmail = (label) =>
  `bench-${label}-${RUN_ID}-${counter++}@example.com`;

// ── Statistics ──────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const round = (v) => Math.round(v * 10) / 10;
  return {
    n: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    mean: round(mean),
    max: round(sorted[sorted.length - 1]),
  };
}

// ── Live Supabase calls (mirroring the server actions) ──────────────────────

async function call(
  path,
  { method = "POST", key = ANON_KEY, token, body } = {},
) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token ?? key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 429) {
    throw new Error(
      "HTTP 429 from Supabase: raise [auth.rate_limit] sign_in_sign_ups for the benchmark (see bench/auth-enumeration/README.md).",
    );
  }
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const created = [];

async function createConfirmedUser(email) {
  const { status, json } = await call("/auth/v1/admin/users", {
    key: SERVICE_ROLE_KEY,
    body: { email, password: PASSWORD, email_confirm: true },
  });
  if (status >= 300) throw new Error(`could not create bench user (${status})`);
  created.push(json.id);
  return json.id;
}

async function cleanup() {
  for (const id of created) {
    await call(`/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      key: SERVICE_ROLE_KEY,
    }).catch(() => undefined);
  }
}

// signIn(): rate-limit check, signInWithPassword, then recordFailure on a
// wrong password (the attacker's case for both classes).
async function liveSignIn(email) {
  await call(
    `/rest/v1/rate_limits?key=eq.${encodeURIComponent(`signin:${email}:bench`)}&select=blocked_until`,
    {
      method: "GET",
      key: SERVICE_ROLE_KEY,
    },
  );
  await call("/auth/v1/token?grant_type=password", {
    body: { email, password: "definitely-wrong-password" }, // scan-secrets-ignore
  });
  await call("/rest/v1/rpc/rate_limit_record_failure", {
    key: SERVICE_ROLE_KEY,
    body: { p_key: `signin:${email}:bench` },
  });
}

// signUp(): GoTrue sign-up; for a genuinely new account also the consent
// insert and the local sign-out the action performs.
async function liveSignUp(email) {
  const { json } = await call("/auth/v1/signup", {
    body: { email, password: PASSWORD },
  });
  const user = json?.user ?? (json?.id ? json : null);
  if (user?.id && (user.identities?.length ?? 0) > 0) {
    created.push(user.id);
    await call("/rest/v1/consent_logs", {
      key: SERVICE_ROLE_KEY,
      body: { user_id: user.id, policy_version: "bench" },
    });
    if (json?.access_token) {
      await call("/auth/v1/logout?scope=local", { token: json.access_token });
    }
  }
}

// ── Simulated latency (no Supabase) ─────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Lognormal-ish latency with a long tail, in ms.
function syntheticLatency(median, spread) {
  const u = 1 - Math.random();
  const v = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(spread * normal);
}
const simulated = {
  signin: {
    existing: () => sleep(syntheticLatency(110, 0.35)), // bcrypt compare
    unknown: () => sleep(syntheticLatency(25, 0.35)),
  },
  signup: {
    existing: () => sleep(syntheticLatency(40, 0.35)), // early return
    unknown: () => sleep(syntheticLatency(260, 0.4)), // insert + consent
  },
};

// ── Runner ──────────────────────────────────────────────────────────────────

async function measure(operation) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function runFlow(flow) {
  const floor =
    flow === "signin" ? SIGN_IN_TIMING_FLOOR_MS : SIGN_UP_TIMING_FLOOR_MS;
  let existingEmail;
  let ops;
  if (MODE === "live") {
    existingEmail = benchEmail(`${flow}-existing`);
    await createConfirmedUser(existingEmail);
    const live = flow === "signin" ? liveSignIn : liveSignUp;
    ops = {
      existing: () => live(existingEmail),
      unknown: () => live(benchEmail(`${flow}-unknown`)),
    };
  } else {
    ops = simulated[flow];
  }

  const raw = { existing: [], unknown: [] };
  const padded = { existing: [], unknown: [] };
  for (let i = 0; i < SAMPLES; i++) {
    // Alternate which class goes first so drift affects both equally.
    const order =
      i % 2 === 0 ? ["existing", "unknown"] : ["unknown", "existing"];
    for (const cls of order) {
      let rawMs = 0;
      const paddedMs = await measure(() =>
        withTimingFloor(floor, async () => {
          rawMs = await measure(ops[cls]);
        }),
      );
      raw[cls].push(rawMs);
      padded[cls].push(paddedMs);
    }
    if ((i + 1) % 25 === 0) {
      process.stderr.write(`  ${flow}: ${i + 1}/${SAMPLES}\n`);
    }
  }

  const result = {
    floorMs: floor,
    raw: { existing: summarize(raw.existing), unknown: summarize(raw.unknown) },
    padded: {
      existing: summarize(padded.existing),
      unknown: summarize(padded.unknown),
    },
  };
  const diff = (a, b) => Math.round(Math.abs(a - b) * 10) / 10;
  result.rawP95DiffMs = diff(result.raw.existing.p95, result.raw.unknown.p95);
  result.paddedP95DiffMs = diff(
    result.padded.existing.p95,
    result.padded.unknown.p95,
  );
  result.floorCoversRawP99 =
    result.raw.existing.p99 < floor && result.raw.unknown.p99 < floor;
  result.pass = result.paddedP95DiffMs < THRESHOLD_MS;
  return result;
}

async function main() {
  if (MODE === "live" && (!ANON_KEY || !SERVICE_ROLE_KEY)) {
    throw new Error(
      "Live mode needs NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY for the local stack (see bench/auth-enumeration/README.md).",
    );
  }
  const flows = FLOW === "both" ? ["signin", "signup"] : [FLOW];
  const report = {
    generatedAt: new Date().toISOString(),
    mode: MODE,
    samplesPerClass: SAMPLES,
    thresholdMs: THRESHOLD_MS,
    node: process.version,
    flows: {},
  };
  try {
    for (const flow of flows) report.flows[flow] = await runFlow(flow);
  } finally {
    if (MODE === "live") await cleanup();
  }

  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`${json}\n`);
  if (OUT_PATH) writeFileSync(resolve(HERE, OUT_PATH), `${json}\n`);

  let failed = false;
  for (const [flow, r] of Object.entries(report.flows)) {
    const verdict = r.pass ? "PASS" : "FAIL";
    process.stderr.write(
      `${verdict} ${flow}: padded p95 diff ${r.paddedP95DiffMs} ms (raw ${r.rawP95DiffMs} ms, floor ${r.floorMs} ms)\n`,
    );
    if (!r.floorCoversRawP99) {
      process.stderr.write(
        `WARN ${flow}: raw p99 reached the ${r.floorMs} ms floor; raise the floor in lib/security/timing.ts\n`,
      );
    }
    failed ||= !r.pass;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
});
