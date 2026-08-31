#!/usr/bin/env node
// ---------------------------------------------------------------------------
// bench/rpc-provider-benchmark/compare.mjs
//
// Compares a fresh benchmark run against the committed baseline, reporting
// improved / regressed / unchanged for every (provider, probe, metric) triple.
//
// Usage:
//   # Compare a pre-existing result file against the baseline:
//   node bench/rpc-provider-benchmark/compare.mjs results/2026-08-20-baseline.json results/my-run.json
//
//   # Run the harness first, then compare in one step:
//   node bench/rpc-provider-benchmark/harness.mjs --out results/current.json
//   node bench/rpc-provider-benchmark/compare.mjs results/2026-08-20-baseline.json results/current.json
//
//   # CI shorthand (uses the default baseline path):
//   node bench/rpc-provider-benchmark/compare.mjs --baseline results/2026-08-20-baseline.json --current results/current.json
//   node bench/rpc-provider-benchmark/compare.mjs --baseline results/2026-08-20-baseline.json --current results/current.json --fail-on-regression
//
// Exit codes:
//   0  — no regressions detected (or --fail-on-regression not set)
//   1  — one or more regressions detected and --fail-on-regression is set
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function flagValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : null;
}
const hasFlag = (flag) => args.includes(flag);

// Support both named flags and positional arguments for convenience:
//   compare.mjs baseline.json current.json
//   compare.mjs --baseline baseline.json --current current.json
const baselinePath =
  flagValue("--baseline") ??
  args.filter((a) => !a.startsWith("--"))[0] ??
  null;
const currentPath =
  flagValue("--current") ??
  args.filter((a) => !a.startsWith("--"))[1] ??
  null;

// Regression threshold: how much worse (ratio) a metric must be before it's
// flagged. Default 1.20 = 20% worse than baseline. Tune with --threshold 1.30.
const THRESHOLD = Number(flagValue("--threshold") ?? "1.20");
const FAIL_ON_REGRESSION = hasFlag("--fail-on-regression");

if (!baselinePath || !currentPath) {
  console.error(
    "Usage: node compare.mjs <baseline.json> <current.json> [--fail-on-regression] [--threshold 1.20]",
  );
  process.exit(1);
}

// ── Load reports ────────────────────────────────────────────────────────────
function loadReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Failed to load ${path}: ${err.message}`);
    process.exit(1);
  }
}

const baseline = loadReport(baselinePath);
const current = loadReport(currentPath);

// ── Comparison logic ────────────────────────────────────────────────────────
// Latency metrics where lower is better.
const LATENCY_METRICS = ["p50", "p95", "p99", "min", "max", "mean"];
// Success-rate metric: higher is better.
const SUCCESS_METRIC = "ok";

/**
 * Classify a (baseline, current) pair for a single numeric metric.
 * @returns {"improved"|"regressed"|"unchanged"|"no-data"}
 */
function classify(bVal, cVal, lowerIsBetter = true) {
  if (bVal === null || bVal === undefined || cVal === null || cVal === undefined) {
    return "no-data";
  }
  if (lowerIsBetter) {
    const ratio = cVal / bVal;
    if (ratio > THRESHOLD) return "regressed";
    if (ratio < 1 / THRESHOLD) return "improved";
    return "unchanged";
  } else {
    // Higher is better (e.g. ok count)
    if (bVal === 0 && cVal === 0) return "unchanged";
    if (bVal === 0) return "improved";
    const ratio = cVal / bVal;
    if (ratio < 1 / THRESHOLD) return "regressed";
    if (ratio > THRESHOLD) return "improved";
    return "unchanged";
  }
}

// Build a lookup map from provider id → probe → summary for each report.
function buildIndex(report) {
  const index = {};
  for (const r of report.results ?? []) {
    index[r.id] = {};
    for (const [probe, summary] of Object.entries(r.probes ?? {})) {
      index[r.id][probe] = summary;
    }
  }
  return index;
}

const bIndex = buildIndex(baseline);
const cIndex = buildIndex(current);

// Collect all provider ids from both reports.
const providerIds = [
  ...new Set([...Object.keys(bIndex), ...Object.keys(cIndex)]),
].sort();

// ── Build diff table ────────────────────────────────────────────────────────
const rows = []; // { provider, probe, metric, baseline, current, status }
const regressions = [];
const improvements = [];

for (const pid of providerIds) {
  const bProvider = bIndex[pid] ?? {};
  const cProvider = cIndex[pid] ?? {};
  const probes = [...new Set([...Object.keys(bProvider), ...Object.keys(cProvider)])].sort();

  for (const probe of probes) {
    const bProbe = bProvider[probe] ?? {};
    const cProbe = cProvider[probe] ?? {};

    for (const metric of LATENCY_METRICS) {
      const bVal = bProbe[metric] ?? null;
      const cVal = cProbe[metric] ?? null;
      const status = classify(bVal, cVal, true);
      rows.push({ provider: pid, probe, metric, baseline: bVal, current: cVal, status });
      if (status === "regressed") regressions.push({ provider: pid, probe, metric, baseline: bVal, current: cVal });
      if (status === "improved") improvements.push({ provider: pid, probe, metric, baseline: bVal, current: cVal });
    }

    // ok count: compare as a fraction of attempts for fairness.
    const bAttempts = bProbe.attempts ?? 0;
    const cAttempts = cProbe.attempts ?? 0;
    const bRate = bAttempts > 0 ? (bProbe[SUCCESS_METRIC] ?? 0) / bAttempts : null;
    const cRate = cAttempts > 0 ? (cProbe[SUCCESS_METRIC] ?? 0) / cAttempts : null;
    const successStatus = classify(bRate, cRate, false /* higher is better */);
    rows.push({
      provider: pid,
      probe,
      metric: "success_rate",
      baseline: bRate !== null ? `${(bRate * 100).toFixed(0)}%` : null,
      current: cRate !== null ? `${(cRate * 100).toFixed(0)}%` : null,
      status: successStatus,
    });
    if (successStatus === "regressed")
      regressions.push({ provider: pid, probe, metric: "success_rate", baseline: bRate, current: cRate });
    if (successStatus === "improved")
      improvements.push({ provider: pid, probe, metric: "success_rate", baseline: bRate, current: cRate });
  }
}

// ── Output ──────────────────────────────────────────────────────────────────
const SYMBOLS = { improved: "↑", regressed: "↓", unchanged: "=", "no-data": "?" };
const COLORS = {
  improved: "\x1b[32m",  // green
  regressed: "\x1b[31m", // red
  unchanged: "\x1b[37m", // white/grey
  "no-data": "\x1b[33m", // yellow
  reset: "\x1b[0m",
};

const isTTY = process.stdout.isTTY;
function colorize(text, status) {
  if (!isTTY) return text;
  return `${COLORS[status] ?? ""}${text}${COLORS.reset}`;
}

console.log(`\nBenchmark comparison`);
console.log(`  Baseline : ${baselinePath}  (generated ${baseline.generatedAt ?? "unknown"})`);
console.log(`  Current  : ${currentPath}  (generated ${current.generatedAt ?? "unknown"})`);
console.log(`  Threshold: ±${((THRESHOLD - 1) * 100).toFixed(0)}% before flagged as improved/regressed\n`);

// Print a per-provider summary table.
for (const pid of providerIds) {
  const providerRows = rows.filter((r) => r.provider === pid);
  const hasChanges = providerRows.some((r) => r.status !== "unchanged" && r.status !== "no-data");

  // Always show providers with regressions; collapse clean ones.
  const providerRegressions = providerRows.filter((r) => r.status === "regressed");
  const providerImprovements = providerRows.filter((r) => r.status === "improved");
  const label = providerRegressions.length > 0
    ? colorize(`▶ ${pid}  [${providerRegressions.length} regression(s)]`, "regressed")
    : providerImprovements.length > 0
    ? colorize(`▶ ${pid}  [${providerImprovements.length} improvement(s)]`, "improved")
    : `▶ ${pid}  [no significant changes]`;

  console.log(label);

  // Show only non-trivial rows (regressions, improvements, and no-data transitions).
  const interesting = providerRows.filter((r) => r.status !== "unchanged");
  if (interesting.length === 0) {
    console.log("    (all metrics within threshold)\n");
    continue;
  }

  // Group by probe for readability.
  const probesSeen = [...new Set(interesting.map((r) => r.probe))];
  for (const probe of probesSeen) {
    console.log(`  ${probe}`);
    for (const row of interesting.filter((r) => r.probe === probe)) {
      const sym = SYMBOLS[row.status] ?? "?";
      const line = `    ${sym} ${row.metric.padEnd(14)} baseline=${String(row.baseline ?? "-").padStart(6)}  current=${String(row.current ?? "-").padStart(6)}`;
      console.log(colorize(line, row.status));
    }
  }
  console.log();
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("─".repeat(60));
console.log(`Summary`);
console.log(`  Regressions  : ${colorize(String(regressions.length), regressions.length > 0 ? "regressed" : "unchanged")}`);
console.log(`  Improvements : ${colorize(String(improvements.length), improvements.length > 0 ? "improved" : "unchanged")}`);
console.log(`  Threshold    : >${((THRESHOLD - 1) * 100).toFixed(0)}% change to flag`);

if (regressions.length > 0) {
  console.log(`\n${colorize("Regressions detected:", "regressed")}`);
  for (const r of regressions) {
    console.log(
      colorize(
        `  ↓ ${r.provider}  ${r.probe}  ${r.metric}  ${r.baseline} → ${r.current}`,
        "regressed",
      ),
    );
  }
}

if (FAIL_ON_REGRESSION && regressions.length > 0) {
  console.error(
    `\nExiting with code 1: ${regressions.length} regression(s) detected. Re-run without --fail-on-regression to see details without blocking.`,
  );
  process.exit(1);
}

if (regressions.length === 0) {
  console.log(colorize("\nAll metrics within threshold. ✓", "improved"));
}
