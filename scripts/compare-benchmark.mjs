#!/usr/bin/env node
// ---------------------------------------------------------------------------
// compare-benchmark.mjs
//
// Compares a new benchmark run against the committed baseline and prints a
// clear per-metric diff (improved / regressed / unchanged) rather than raw
// numbers alone.  Exits non-zero when any metric regresses beyond the
// threshold so CI can flag meaningful regressions automatically.
//
// Usage:
//   node scripts/compare-benchmark.mjs --current <path-to-new-results.json>
//   node scripts/compare-benchmark.mjs \
//     --current results/latest.json \
//     --baseline bench/rpc-provider-benchmark/results/2026-08-20-baseline.json \
//     --threshold 25
//
// Flags:
//   --current    (required) path to the newly generated benchmark JSON
//   --baseline   path to the baseline JSON
//                (default: bench/rpc-provider-benchmark/results/2026-08-20-baseline.json)
//   --threshold  regression threshold in percent (default: 20)
//                A probe's p50/p95/p99 is flagged as regressed when the new
//                value exceeds the baseline value by more than this percentage.
//   --metric     which latency metric to use as the primary regression signal
//                (default: p50; options: p50, p95, p99, mean)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const DEFAULT_BASELINE = join(
  process.cwd(),
  "bench/rpc-provider-benchmark/results/2026-08-20-baseline.json",
);

const CURRENT_PATH = argValue("--current", "");
const BASELINE_PATH = argValue("--baseline", DEFAULT_BASELINE);
const THRESHOLD_PCT = Number(argValue("--threshold", "20"));
const METRIC = argValue("--metric", "p50");

const VALID_METRICS = ["p50", "p95", "p99", "mean"];

if (!CURRENT_PATH) {
  console.error(
    "Error: --current <path> is required.\n\n" +
      "  node scripts/compare-benchmark.mjs --current bench/rpc-provider-benchmark/results/my-run.json",
  );
  process.exit(1);
}

if (!VALID_METRICS.includes(METRIC)) {
  console.error(
    `Error: --metric must be one of: ${VALID_METRICS.join(", ")}. Got: ${METRIC}`,
  );
  process.exit(1);
}

// ── Load files ──────────────────────────────────────────────────────────────

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Error loading ${path}: ${err.message}`);
    process.exit(1);
  }
}

const current = loadJson(CURRENT_PATH);
const baseline = loadJson(BASELINE_PATH);

// ── Build lookup maps ────────────────────────────────────────────────────────
// Keyed by "<provider-id>/<probe-name>" for fast lookup.

function buildIndex(report) {
  const idx = {};
  for (const provider of report.results ?? []) {
    for (const [probe, stats] of Object.entries(provider.probes ?? {})) {
      idx[`${provider.id}/${probe}`] = stats;
    }
  }
  return idx;
}

const baselineIdx = buildIndex(baseline);
const currentIdx = buildIndex(current);

// ── Compare ──────────────────────────────────────────────────────────────────

const COLS = {
  provider: 30,
  probe: 22,
  metric: 7,
  baseline: 10,
  current: 10,
  change: 10,
  status: 12,
};

function pad(s, len, right = false) {
  const str = String(s ?? "-");
  return right ? str.padStart(len) : str.padEnd(len);
}

function statusLabel(changePct) {
  if (changePct === null) return "n/a";
  if (changePct > THRESHOLD_PCT) return "⚠ REGRESSED";
  if (changePct < -5) return "✓ improved";
  return "  unchanged";
}

const header = [
  pad("provider", COLS.provider),
  pad("probe", COLS.probe),
  pad("metric", COLS.metric),
  pad("baseline", COLS.baseline, true),
  pad("current", COLS.current, true),
  pad("Δ%", COLS.change, true),
  pad("status", COLS.status),
].join("  ");

const separator = "-".repeat(header.length);

console.log(`\nBenchmark comparison`);
console.log(`  baseline : ${BASELINE_PATH}`);
console.log(`  current  : ${CURRENT_PATH}`);
console.log(`  metric   : ${METRIC}`);
console.log(`  threshold: ${THRESHOLD_PCT}% regression triggers failure`);
console.log("");
console.log(header);
console.log(separator);

const regressions = [];
const allKeys = new Set([...Object.keys(baselineIdx), ...Object.keys(currentIdx)]);

for (const key of [...allKeys].sort()) {
  const [providerId, probe] = key.split("/");
  const b = baselineIdx[key];
  const c = currentIdx[key];

  const bVal = b?.[METRIC] ?? null;
  const cVal = c?.[METRIC] ?? null;

  let changePct = null;
  let changeStr = "n/a";
  if (bVal !== null && cVal !== null) {
    changePct = Math.round(((cVal - bVal) / bVal) * 100);
    changeStr = (changePct >= 0 ? "+" : "") + changePct + "%";
  } else if (bVal === null && cVal !== null) {
    changeStr = "new";
  } else if (bVal !== null && cVal === null) {
    changeStr = "missing";
  }

  const status = statusLabel(changePct);

  console.log(
    [
      pad(providerId, COLS.provider),
      pad(probe, COLS.probe),
      pad(METRIC, COLS.metric),
      pad(bVal ?? "-", COLS.baseline, true),
      pad(cVal ?? "-", COLS.current, true),
      pad(changeStr, COLS.change, true),
      pad(status, COLS.status),
    ].join("  "),
  );

  if (changePct !== null && changePct > THRESHOLD_PCT) {
    regressions.push({ key, probe, providerId, bVal, cVal, changePct });
  }
}

console.log(separator);

// ── Summary ──────────────────────────────────────────────────────────────────

const newKeys = [...allKeys].filter(
  (k) => !baselineIdx[k] && currentIdx[k],
).length;
const missingKeys = [...allKeys].filter(
  (k) => baselineIdx[k] && !currentIdx[k],
).length;
const improvedCount = [...allKeys].filter((k) => {
  const b = baselineIdx[k]?.[METRIC];
  const c = currentIdx[k]?.[METRIC];
  return b !== null && b !== undefined && c !== null && c !== undefined
    ? c < b * 0.95
    : false;
}).length;

console.log(`\nSummary`);
console.log(
  `  improved : ${improvedCount}  regressed : ${regressions.length}  new : ${newKeys}  missing : ${missingKeys}`,
);

if (regressions.length > 0) {
  console.log(`\n⚠  Regressions (>${THRESHOLD_PCT}% on ${METRIC}):`);
  for (const r of regressions) {
    console.log(
      `  ${r.key}  baseline=${r.bVal}ms  current=${r.cVal}ms  (+${r.changePct}%)`,
    );
  }
  console.log(
    `\nAction: investigate the regressed providers above, or update the baseline if the\n` +
      `change is intentional (see bench/rpc-provider-benchmark/README.md).\n`,
  );
  process.exit(1);
} else {
  console.log(`\n✓ No regressions detected.\n`);
}
