#!/usr/bin/env node
// Issue #693: generate platform cron config from lib/ops/schedules.json and
// fail CI when an internal route is unregistered or vercel.json has drifted.
//
//   node scripts/schedules.mjs           # write vercel.json crons
//   node scripts/schedules.mjs --check   # verify manifest coverage + no drift
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(
  readFileSync(join(root, "lib/ops/schedules.json"), "utf8"),
);
const check = process.argv.includes("--check");
const errors = [];

function routeFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return entry === "route.ts" ? [full] : [];
  });
}

const routes = ["app/api/internal", "app/api/outbox"]
  .flatMap((dir) => routeFiles(join(root, dir)))
  .map(
    (file) =>
      "/" + relative(join(root, "app"), file).split(sep).slice(0, -1).join("/"),
  );

const byPath = new Map(manifest.jobs.map((job) => [job.path, job]));
for (const route of routes) {
  if (!byPath.has(route)) {
    errors.push(
      `${route} has no entry in lib/ops/schedules.json (add a schedule or "manualOnly": true)`,
    );
  }
}
for (const job of manifest.jobs) {
  if (!routes.includes(job.path))
    errors.push(`${job.name}: route ${job.path} does not exist`);
  if (!job.owner) errors.push(`${job.name}: missing owner`);
  if (job.manualOnly) {
    if (!job.reason)
      errors.push(`${job.name}: manualOnly entries need a reason`);
    continue;
  }
  for (const field of [
    "schedule",
    "maxDurationSeconds",
    "idempotency",
    "maxStalenessSeconds",
  ]) {
    if (job[field] === undefined) errors.push(`${job.name}: missing ${field}`);
  }
}

const vercelPath = join(root, "vercel.json");
const current = existsSync(vercelPath)
  ? JSON.parse(readFileSync(vercelPath, "utf8"))
  : {};
const next = {
  ...current,
  crons: manifest.jobs
    .filter((job) => !job.manualOnly)
    .map((job) => ({ path: job.path, schedule: job.schedule })),
  functions: {
    ...current.functions,
    ...Object.fromEntries(
      manifest.jobs
        .filter((job) => !job.manualOnly)
        .map((job) => [
          `app${job.path}/route.ts`,
          { maxDuration: job.maxDurationSeconds },
        ]),
    ),
  },
};
const rendered = JSON.stringify(next, null, 2) + "\n";

if (check) {
  if (
    !existsSync(vercelPath) ||
    readFileSync(vercelPath, "utf8") !== rendered
  ) {
    errors.push(
      "vercel.json is out of date with lib/ops/schedules.json (run npm run schedules:generate)",
    );
  }
  if (errors.length) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log(
    `✓ ${routes.length} internal routes registered; vercel.json in sync`,
  );
} else {
  if (errors.length) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  writeFileSync(vercelPath, rendered);
  console.log("wrote vercel.json");
}
