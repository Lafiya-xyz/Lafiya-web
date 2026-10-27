#!/usr/bin/env node
// Postgres upgrade rehearsal checks (issue #811). Run against a local Supabase
// stack that has just replayed every migration on the target version:
//
//   node scripts/pg-upgrade-rehearsal.mjs            # verify + compare plans
//   node scripts/pg-upgrade-rehearsal.mjs --update   # rewrite plan baseline
//
// 1. Verifies supabase/extensions.manifest.json against the running server
//    (pass --target-major N to check the rehearsal's target major instead).
// 2. EXPLAINs the hot paths (emergency read, profile read) and reports plan
//    regressions against scripts/pg-plan-baseline.json: a cost increase above
//    COST_TOLERANCE, or a sequential scan where the baseline used an index.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DB_URL =
  process.env.REHEARSAL_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const BASELINE = "scripts/pg-plan-baseline.json";
const COST_TOLERANCE = 1.5;
const SAMPLE_ID = "00000000-0000-4000-8000-000000000000";

// Hot paths read by get_emergency_card() and the profile pages.
const HOT_PATHS = {
  emergencyRead: `select * from public.profiles where card_public_id = '${SAMPLE_ID}'`,
  profileRead: `select * from public.profiles where user_id = '${SAMPLE_ID}'`,
  emergencyAccessLog: `select * from public.card_access_events where user_id = '${SAMPLE_ID}' order by observed_at desc limit 50`,
};

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const psql = (sql) =>
  execFileSync("psql", [DB_URL, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  }).trim();

const failures = [];
const report = ["### Postgres upgrade rehearsal", ""];

// 1. Extension manifest
const manifest = JSON.parse(readFileSync("supabase/extensions.manifest.json", "utf8"));
const expectedMajor = Number(arg("--target-major") ?? manifest.postgres.majorVersion);
const serverMajor = Math.floor(Number(psql("show server_version_num")) / 10_000);
report.push(`Server major: ${serverMajor} (expected ${expectedMajor})`);
if (serverMajor !== expectedMajor) failures.push(`server major ${serverMajor} != ${expectedMajor}`);

const installed = new Map(
  psql("select extname || '=' || extversion from pg_extension")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("=")),
);
const cmp = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
report.push("", "| Extension | Installed | Minimum | Status |", "| --- | --- | --- | --- |");
for (const [name, spec] of Object.entries(manifest.extensions)) {
  const v = installed.get(name);
  let status = "ok";
  if (!v) status = spec.required ? "MISSING" : "absent (optional)";
  else if (cmp(v, spec.minVersion) < 0) status = "TOO OLD";
  if (status === "MISSING" || status === "TOO OLD") failures.push(`${name}: ${status}`);
  report.push(`| ${name} | ${v ?? "–"} | ${spec.minVersion} | ${status} |`);
}

// 2. Query plans
function summarise(sql) {
  const [plan] = JSON.parse(psql(`explain (format json) ${sql}`));
  const nodes = [];
  const walk = (n) => {
    nodes.push(n["Node Type"]);
    (n.Plans ?? []).forEach(walk);
  };
  walk(plan.Plan);
  return { cost: plan.Plan["Total Cost"], seqScan: nodes.includes("Seq Scan"), nodes };
}

psql("analyze public.profiles; analyze public.card_access_events;");
const current = Object.fromEntries(
  Object.entries(HOT_PATHS).map(([k, sql]) => [k, summarise(sql)]),
);

if (process.argv.includes("--update") || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  report.push("", `Plan baseline written to \`${BASELINE}\`.`);
} else {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  report.push("", "| Hot path | Baseline cost | Cost | Seq scan | Status |", "| --- | --- | --- | --- | --- |");
  for (const [k, cur] of Object.entries(current)) {
    const b = baseline[k];
    const problems = [];
    if (b && cur.cost > b.cost * COST_TOLERANCE) problems.push("cost regression");
    if (b && cur.seqScan && !b.seqScan) problems.push("new seq scan");
    if (problems.length) failures.push(`${k}: ${problems.join(", ")}`);
    report.push(
      `| ${k} | ${b?.cost ?? "–"} | ${cur.cost} | ${cur.seqScan ? "yes" : "no"} | ${problems.join(", ") || "ok"} |`,
    );
  }
}

report.push("", failures.length ? `**${failures.length} problem(s):** ${failures.join("; ")}` : "All rehearsal checks passed.");
const markdown = report.join("\n");
console.log(markdown);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, { flag: "a" });
if (failures.length) process.exitCode = 1;
