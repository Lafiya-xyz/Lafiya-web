#!/usr/bin/env node
/**
 * scripts/perf-lab.mjs
 *
 * Low-end Android performance lab (issue #778). Loads each scenario in
 * perf/low-end-budgets.json in Chromium with CPU throttling, slow-4G and a
 * capped JS heap, records a DevTools trace per run, and compares the median
 * of N runs against the budgets.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node scripts/perf-lab.mjs
 *
 * Env:
 *   BASE_URL            origin of a running production build (default localhost:3000)
 *   PERF_FAIL_MARGIN    overrides failMargin from the budget file (e.g. 0.15)
 *   GITHUB_STEP_SUMMARY when set, a markdown summary is appended to it
 *
 * Output: artifacts/perf-lab/<scenario>-run<N>.trace.json and results.json.
 * Exit codes: 0 within budget, 1 over budget (median > max × (1 + margin)).
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const OUT = join(ROOT, "artifacts/perf-lab");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const config = JSON.parse(
  readFileSync(join(ROOT, "perf/low-end-budgets.json"), "utf8"),
);
const margin = Number(process.env.PERF_FAIL_MARGIN ?? config.failMargin);
const { device } = config;

// Collects long tasks from navigation start; read back after load settles.
const LONG_TASK_OBSERVER = () => {
  window.__perfLabLongTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      window.__perfLabLongTasks.push(e.duration);
  }).observe({ type: "longtask", buffered: true });
};

async function measure(browser, scenario, name, run) {
  const context = await browser.newContext({
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const url = new URL(scenario.path, BASE_URL).toString();

  if (scenario.offline) {
    // Prime the service worker cache online, then reload with no network.
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => navigator.serviceWorker?.ready);
    await context.setOffline(true);
  }

  await page.addInitScript(LONG_TASK_OBSERVER);
  await page.addInitScript(
    (gb) => Object.defineProperty(navigator, "deviceMemory", { get: () => gb }),
    device.deviceMemoryGb,
  );
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: device.cpuSlowdown,
  });
  if (!scenario.offline) {
    const kbps = (k) => (k * 1024) / 8;
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: device.network.latencyMs,
      downloadThroughput: kbps(device.network.downloadKbps),
      uploadThroughput: kbps(device.network.uploadKbps),
    });
  }

  const tracePath = join(OUT, `${name}-run${run}.trace.json`);
  await browser.startTracing(page, { path: tracePath, screenshots: false });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(2_000); // let post-load hydration tasks land
  await browser.stopTracing();

  const longTasks = await page.evaluate(() => window.__perfLabLongTasks);
  const { metrics } = await cdp.send("Performance.getMetrics");
  const heap = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  await context.close();

  return {
    longTaskCount: longTasks.length,
    totalBlockingTimeMs: Math.round(
      longTasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0),
    ),
    jsHeapUsedMb: Number((heap / 1024 / 1024).toFixed(2)),
    trace: tracePath,
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function coefficientOfVariation(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return sd / mean;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: [`--js-flags=--max-old-space-size=${device.jsHeapLimitMb}`],
  });
  const results = {};
  let failed = false;

  try {
    for (const [name, scenario] of Object.entries(config.scenarios)) {
      const runs = [];
      for (let i = 1; i <= config.runs; i++)
        runs.push(await measure(browser, scenario, name, i));
      results[name] = {};
      for (const [metric, budget] of Object.entries(scenario.budgets)) {
        const values = runs.map((r) => r[metric]);
        const value = median(values);
        const limit = budget.max * (1 + margin);
        const cv = coefficientOfVariation(values);
        const ok = value <= limit;
        failed ||= !ok;
        results[name][metric] = {
          median: value,
          budget: budget.max,
          limit,
          cv: Number(cv.toFixed(3)),
          runs: values,
          ok,
        };
      }
      results[name].traces = runs.map((r) => r.trace);
    }
  } finally {
    await browser.close();
  }

  writeFileSync(
    join(OUT, "results.json"),
    `${JSON.stringify({ baseUrl: BASE_URL, margin, results }, null, 2)}\n`,
  );
  const summary = renderSummary(results);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.exit(failed ? 1 : 0);
}

function renderSummary(results) {
  const lines = [
    `## Low-end Android perf lab (${device.cpuSlowdown}× CPU, ${device.network.name}, ${config.runs} runs, margin ${Math.round(margin * 100)}%)`,
    "",
    "| Scenario | Metric | Median | Budget | Run-to-run CV | Status |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const [name, metrics] of Object.entries(results)) {
    for (const [metric, r] of Object.entries(metrics)) {
      if (metric === "traces") continue;
      const cv = `${(r.cv * 100).toFixed(1)}%${r.cv > config.maxCoefficientOfVariation ? " ⚠️" : ""}`;
      lines.push(
        `| ${name} | ${metric} | ${r.median} | ${r.budget} | ${cv} | ${r.ok ? "✅" : "❌ over budget"} |`,
      );
    }
  }
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_RUN_ID) {
    lines.push(
      "",
      `Traces: [perf-lab-traces artifact](${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}#artifacts) — open in chrome://tracing or the DevTools Performance panel.`,
    );
  }
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
