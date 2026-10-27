#!/usr/bin/env node
/**
 * error-budget.mjs — Error-budget policy engine for the public-card
 * availability SLO (99.9% over a rolling 30-day window).
 *
 * Computes multi-window burn-rate alerts (Google SRE Book, Chapter 5) and
 * determines whether the release gate should be OPEN, WARN, or BLOCKED.
 *
 * Usage:
 *   node scripts/error-budget.mjs --metrics <path>   # evaluate from file
 *   node scripts/error-budget.mjs --help             # usage
 *
 * Input JSON schema (--metrics):
 * {
 *   "windowSeconds": 2592000,   // 30d rolling window
 *   "sloTarget": 0.999,         // 99.9%
 *   "totalRequests": 1000000,
 *   "successfulRequests": 998500,
 *   "windows": [
 *     { "label": "1h",  "totalRequests": 500, "successfulRequests": 499 },
 *     { "label": "6h",  "totalRequests": 3000, "successfulRequests": 2994 },
 *     { "label": "24h", "totalRequests": 12000, "successfulRequests": 11982 },
 *     { "label": "72h", "totalRequests": 36000, "successfulRequests": 35964 }
 *   ]
 * }
 *
 * Output (stdout JSON, exit code 0 always — caller interprets gate status):
 * {
 *   "sloTarget": 0.999,
 *   "errorBudgetMinutes": 43.2,
 *   "consumedMinutes": 30.0,
 *   "remainingMinutes": 13.2,
 *   "consumedFraction": 0.694,
 *   "remainingFraction": 0.306,
 *   "burnRates": { "1h": 1.3, "6h": 0.9, "24h": 0.8, "72h": 0.7 },
 *   "alerts": [
 *     { "window": "1h", "burnRate": 1.3, "threshold": 1.0,
 *       "severity": "warn", "message": "..." }
 *   ],
 *   "gateStatus": "warn",   // "open" | "warn" | "blocked"
 *   "gateReason": "..."
 * }
 */

import { readFileSync } from "node:fs";

// ── SLO parameters ────────────────────────────────────────────────────────────

/** 30-day rolling window in seconds */
const DEFAULT_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** Public-card availability SLO: 99.9% */
const DEFAULT_SLO_TARGET = 0.999;

/**
 * Multi-window burn-rate thresholds (Google SRE Book §5.3).
 *
 * A burn rate of 1.0 means the budget will be exactly exhausted in the full
 * 30-day window. A burn rate of 14.4 over 1 hour means the budget will be
 * exhausted in 2 hours.
 *
 * Severity:
 *   warn    — budget burning faster than sustainable; non-blocking advisory
 *   page    — high burn rate; blocks non-fix releases
 *   blocked — budget exhausted (remaining < 0); blocks all non-fix releases
 */
export const BURN_RATE_THRESHOLDS = [
  { window: "1h",  burnRateThreshold: 14.4, severity: "page" },
  { window: "6h",  burnRateThreshold: 6.0,  severity: "page" },
  { window: "24h", burnRateThreshold: 3.0,  severity: "warn" },
  { window: "72h", burnRateThreshold: 1.0,  severity: "warn" },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute the error rate for a window.
 * @param {number} total
 * @param {number} successful
 * @returns {number} error rate in [0, 1]
 */
export function errorRate(total, successful) {
  if (total === 0) return 0;
  return Math.max(0, (total - successful) / total);
}

/**
 * Compute the burn rate for a window relative to the SLO target.
 *
 * burnRate = windowErrorRate / (1 - sloTarget)
 *
 * A burn rate of 1.0 is exactly sustainable.
 * @param {number} windowErrorRate
 * @param {number} sloTarget
 * @returns {number}
 */
export function burnRate(windowErrorRate, sloTarget) {
  const errorBudgetRate = 1 - sloTarget;
  if (errorBudgetRate === 0) return Infinity;
  return windowErrorRate / errorBudgetRate;
}

/**
 * Compute the total error budget in minutes for the rolling window.
 * @param {number} windowSeconds
 * @param {number} sloTarget
 * @returns {number} error budget in minutes
 */
export function errorBudgetMinutes(windowSeconds, sloTarget) {
  return (windowSeconds / 60) * (1 - sloTarget);
}

/**
 * Evaluate multi-window burn rates and determine the gate status.
 *
 * @param {object} metrics
 * @param {number} metrics.windowSeconds
 * @param {number} metrics.sloTarget
 * @param {number} metrics.totalRequests
 * @param {number} metrics.successfulRequests
 * @param {Array<{label: string, totalRequests: number, successfulRequests: number}>} metrics.windows
 * @returns {object} evaluation result
 */
export function evaluateErrorBudget(metrics) {
  const {
    windowSeconds = DEFAULT_WINDOW_SECONDS,
    sloTarget = DEFAULT_SLO_TARGET,
    totalRequests,
    successfulRequests,
    windows = [],
  } = metrics;

  // ── Overall budget ────────────────────────────────────────────────────────

  const budgetMinutes = errorBudgetMinutes(windowSeconds, sloTarget);
  const overallErrorRate = errorRate(totalRequests, successfulRequests);
  const consumedMinutes = (windowSeconds / 60) * overallErrorRate;
  const remainingMinutes = budgetMinutes - consumedMinutes;
  const consumedFraction = budgetMinutes > 0 ? consumedMinutes / budgetMinutes : 0;
  const remainingFraction = 1 - consumedFraction;

  // ── Per-window burn rates ──────────────────────────────────────────────────

  const windowRates = {};
  for (const w of windows) {
    const rate = errorRate(w.totalRequests, w.successfulRequests);
    windowRates[w.label] = burnRate(rate, sloTarget);
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  const alerts = [];
  for (const threshold of BURN_RATE_THRESHOLDS) {
    const rate = windowRates[threshold.window];
    if (rate === undefined) continue;
    if (rate > threshold.burnRateThreshold) {
      alerts.push({
        window: threshold.window,
        burnRate: Number(rate.toFixed(2)),
        threshold: threshold.burnRateThreshold,
        severity: threshold.severity,
        message: `${threshold.window} burn rate ${rate.toFixed(2)}x exceeds ${threshold.burnRateThreshold}x threshold (severity: ${threshold.severity})`,
      });
    }
  }

  // ── Gate status ───────────────────────────────────────────────────────────
  // Rules (in priority order):
  //   1. Budget exhausted (remaining < 0) → blocked
  //   2. Any "page"-severity alert → blocked
  //   3. Any "warn"-severity alert → warn
  //   4. Otherwise → open

  let gateStatus = "open";
  let gateReason = "Error budget is healthy. No burn-rate alerts.";

  if (remainingFraction <= 0) {
    gateStatus = "blocked";
    gateReason =
      `Error budget exhausted: ${(consumedFraction * 100).toFixed(1)}% consumed ` +
      `(${consumedMinutes.toFixed(1)} of ${budgetMinutes.toFixed(1)} minutes). ` +
      "Only fixes that address the availability gap may be released. " +
      "See docs/operations/error-budget-policy.md for the override procedure.";
  } else {
    const pageAlerts = alerts.filter((a) => a.severity === "page");
    const warnAlerts = alerts.filter((a) => a.severity === "warn");
    if (pageAlerts.length > 0) {
      gateStatus = "blocked";
      gateReason =
        `High burn rate on ${pageAlerts.map((a) => a.window).join(", ")} window(s). ` +
        "This pace exhausts the error budget in < 2 hours. " +
        "Only reliability fixes may be released. " +
        "Override requires a documented reason and actor — see docs/operations/error-budget-policy.md.";
    } else if (warnAlerts.length > 0) {
      gateStatus = "warn";
      gateReason =
        `Elevated burn rate on ${warnAlerts.map((a) => a.window).join(", ")} window(s). ` +
        `${(remainingFraction * 100).toFixed(1)}% of error budget remains. ` +
        "Review before releasing.";
    } else if (remainingFraction < 0.1) {
      gateStatus = "warn";
      gateReason =
        `Only ${(remainingFraction * 100).toFixed(1)}% of error budget remains ` +
        `(${remainingMinutes.toFixed(1)} minutes). Proceed with caution.`;
    }
  }

  return {
    sloTarget,
    errorBudgetMinutes: Number(budgetMinutes.toFixed(2)),
    consumedMinutes: Number(consumedMinutes.toFixed(2)),
    remainingMinutes: Number(remainingMinutes.toFixed(2)),
    consumedFraction: Number(consumedFraction.toFixed(4)),
    remainingFraction: Number(remainingFraction.toFixed(4)),
    burnRates: Object.fromEntries(
      Object.entries(windowRates).map(([k, v]) => [k, Number(v.toFixed(2))]),
    ),
    alerts,
    gateStatus,
    gateReason,
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const args = process.argv.slice(2);
  const metricsFlag = args.indexOf("--metrics");
  const helpFlag = args.includes("--help") || args.includes("-h");

  if (helpFlag) {
    console.log(`
Usage: node scripts/error-budget.mjs --metrics <path>

Evaluates error-budget consumption and burn rates from a metrics JSON file.
See the file header for input schema documentation.

Output is JSON on stdout. Exit code is always 0; interpret gateStatus:
  open    — budget healthy, no alerts
  warn    — elevated burn rate; non-blocking advisory
  blocked — budget exhausted or high burn rate; block non-fix releases
`);
    process.exit(0);
  }

  let metrics;
  if (metricsFlag !== -1 && args[metricsFlag + 1]) {
    const metricsPath = args[metricsFlag + 1];
    try {
      metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
    } catch (err) {
      console.error(`Error reading metrics file: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.error("Usage: node scripts/error-budget.mjs --metrics <path>");
    process.exit(1);
  }

  const result = evaluateErrorBudget(metrics);
  console.log(JSON.stringify(result, null, 2));
}
