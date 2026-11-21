#!/usr/bin/env node
/**
 * perf/capacity-model.mjs
 *
 * Parameterized end-to-end capacity model for a national-scale rollout
 * (issue #886). Pure arithmetic — no network, no database, no secrets.
 *
 * Usage:
 *   node perf/capacity-model.mjs                       # 10M cards, defaults
 *   node perf/capacity-model.mjs --cards=1000000       # override any assumption
 *   node perf/capacity-model.mjs --json                # machine-readable output
 *   node perf/capacity-model.mjs --help
 *
 * Every assumption lives in perf/capacity-assumptions.json and can be
 * overridden on the command line (`--key=value`). The model prints a table of
 * the derived quantities (DB size, connections, RPC volume, SMS cost, storage
 * growth, serverless spend) plus the top bottlenecks ranked by how close they
 * run to their configured ceiling.
 *
 * Exit codes: 0 model produced, 1 bad input.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const ASSUMPTIONS_PATH = join(ROOT, "perf/capacity-assumptions.json");

const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const BYTES_PER_GB = 1024 ** 3;

function loadAssumptions() {
  return JSON.parse(readFileSync(ASSUMPTIONS_PATH, "utf8"));
}

/** Flatten nested assumption groups into `group.key` → number. */
function flatten(obj, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else if (typeof value === "number") {
      out[path] = value;
    }
  }
  return out;
}

function parseOverrides(argv) {
  const overrides = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z0-9_.]+)=(.+)$/.exec(arg);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) {
      throw new Error(`--${match[1]} must be a number, got "${match[2]}"`);
    }
    overrides[match[1]] = value;
  }
  return overrides;
}

/**
 * Build the model. `a` is the flattened assumption map; every derived value is
 * a plain number so the result can be serialized or asserted on.
 */
export function buildModel(a) {
  const cards = a.cards;
  const activeShare = a.population.activeShare;
  const activeCards = cards * activeShare;

  // ── Database ──────────────────────────────────────────────────────────────
  const rowBytes = a.db.bytesPerProfileRow;
  const auditRowsPerCardMonth = a.db.auditRowsPerCardMonth;
  const dbBytesYear1 =
    cards * rowBytes +
    cards * auditRowsPerCardMonth * 12 * a.db.bytesPerAuditRow +
    cards * a.db.bytesPerCardAttachment;
  const dbBytesYear3 = dbBytesYear1 * (1 + a.db.annualGrowthRate * 2);
  const dbGbYear3 = dbBytesYear3 / BYTES_PER_GB;
  const dbGbPerCard = dbBytesYear1 / BYTES_PER_GB / cards;

  // ── Connections ───────────────────────────────────────────────────────────
  // Peak concurrent DB-bound requests = peak RPS × DB-bound share × latency.
  const peakRps = (activeCards * a.traffic.requestsPerActiveCardPerDay) / 86400;
  const peakRpsBurst = peakRps * a.traffic.peakToAverageRatio;
  const dbBoundRps = peakRpsBurst * a.traffic.dbBoundShare;
  const concurrentDbRequests = dbBoundRps * a.traffic.dbLatencySeconds;
  const poolerConnections = Math.ceil(
    concurrentDbRequests / a.db.requestsPerConnection,
  );
  const poolerCeiling = a.db.poolerMaxConnections;

  // ── RPC / Stellar volume ──────────────────────────────────────────────────
  const rpcCallsPerMonth =
    activeCards * a.traffic.requestsPerActiveCardPerDay * a.traffic.rpcShare * 30;
  const rpcCallsPerSecondPeak =
    (rpcCallsPerMonth / SECONDS_PER_MONTH) * a.traffic.peakToAverageRatio;
  const rpcCeiling = a.rpc.providerRequestsPerSecond;

  // ── SMS ───────────────────────────────────────────────────────────────────
  const smsPerMonth =
    activeCards * a.sms.messagesPerActiveCardPerMonth +
    cards * a.sms.onboardingMessagesPerCard;
  const smsCostPerMonth = smsPerMonth * a.sms.costPerMessageUsd;

  // ── Storage growth ────────────────────────────────────────────────────────
  const storageGbYear1 =
    (cards * a.storage.bytesPerCardYear1) / BYTES_PER_GB;
  const storageGbYear3 = storageGbYear1 * (1 + a.storage.annualGrowthRate * 2);
  const storageCostPerMonthYear3 = storageGbYear3 * a.storage.costPerGbMonthUsd;

  // ── Serverless spend ──────────────────────────────────────────────────────
  const invocationsPerMonth =
    activeCards * a.traffic.requestsPerActiveCardPerDay * 30;
  const gbSecondsPerMonth =
    invocationsPerMonth * a.serverless.avgDurationMs * a.serverless.memoryGb * 0.001;
  const serverlessCostPerMonth =
    (invocationsPerMonth / 1_000_000) * a.serverless.costPerMillionInvocationsUsd +
    gbSecondsPerMonth * a.serverless.costPerGbSecondUsd;

  // ── Bandwidth (egress) ────────────────────────────────────────────────────
  const egressGbPerMonth =
    (invocationsPerMonth * a.traffic.avgResponseBytes) / BYTES_PER_GB;
  const egressCostPerMonth = egressGbPerMonth * a.serverless.costPerGbEgressUsd;

  const monthlyRunRateUsd =
    smsCostPerMonth +
    storageCostPerMonthYear3 +
    serverlessCostPerMonth +
    egressCostPerMonth;

  // ── Bottlenecks ───────────────────────────────────────────────────────────
  // Each entry: utilization = projected / ceiling. > 1 means the ceiling is
  // breached at national scale.
  const bottlenecks = [
    {
      id: "db-connections",
      label: "Postgres pooler connections",
      projected: poolerConnections,
      ceiling: poolerCeiling,
      unit: "connections",
      mitigation:
        "Raise Supavisor pool size / add read replicas for the public card RPC; cache card reads at the edge (ISR + CDN) to cut DB-bound share.",
    },
    {
      id: "rpc-throughput",
      label: "Stellar RPC provider throughput",
      projected: rpcCallsPerSecondPeak,
      ceiling: rpcCeiling,
      unit: "req/s",
      mitigation:
        "Batch attestation reads, add a read-through cache for attestation lookups, and negotiate a dedicated RPC tier or run a fallback provider.",
    },
    {
      id: "sms-spend",
      label: "SMS spend",
      projected: smsCostPerMonth,
      ceiling: a.sms.monthlyBudgetUsd,
      unit: "USD/month",
      mitigation:
        "Shift OTP delivery to WhatsApp/USSD fallback, shorten message bodies, and renegotiate per-message rates at national volume.",
    },
    {
      id: "storage-growth",
      label: "Object storage footprint (year 3)",
      projected: storageGbYear3,
      ceiling: a.storage.quotaGb,
      unit: "GB",
      mitigation:
        "Enforce upload-time resize (already 40 kB target), lifecycle-expire superseded photos, and move cold exports to cheaper tiers.",
    },
    {
      id: "serverless-spend",
      label: "Serverless + egress spend",
      projected: serverlessCostPerMonth + egressCostPerMonth,
      ceiling: a.serverless.monthlyBudgetUsd,
      unit: "USD/month",
      mitigation:
        "Serve the public card from ISR/CDN (near-zero invocations), trim response payloads to the perf budget, and move batch jobs to scheduled workers.",
    },
  ]
    .map((b) => ({ ...b, utilization: b.projected / b.ceiling }))
    .sort((x, y) => y.utilization - x.utilization);

  return {
    assumptions: a,
    cards,
    activeCards,
    db: {
      bytesYear1: dbBytesYear1,
      bytesYear3: dbBytesYear3,
      gbYear3: dbGbYear3,
      gbPerCard: dbGbPerCard,
    },
    connections: {
      peakRps,
      peakRpsBurst,
      dbBoundRps,
      concurrentDbRequests,
      poolerConnections,
      poolerCeiling,
    },
    rpc: { callsPerMonth: rpcCallsPerMonth, callsPerSecondPeak: rpcCallsPerSecondPeak },
    sms: { messagesPerMonth: smsPerMonth, costPerMonthUsd: smsCostPerMonth },
    storage: { gbYear1: storageGbYear1, gbYear3: storageGbYear3 },
    serverless: {
      invocationsPerMonth,
      gbSecondsPerMonth,
      costPerMonthUsd: serverlessCostPerMonth,
      egressGbPerMonth,
      egressCostPerMonthUsd: egressCostPerMonth,
    },
    monthlyRunRateUsd,
    annualRunRateUsd: monthlyRunRateUsd * 12,
    bottlenecks,
  };
}

function fmt(n, digits = 0) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function printReport(model) {
  const { db, connections, rpc, sms, storage, serverless } = model;
  const lines = [
    `Capacity model — ${fmt(model.cards)} cards (${fmt(model.activeCards)} active)`,
    "",
    "Database",
    `  size year 1            ${fmt(db.bytesYear1 / BYTES_PER_GB, 1)} GB`,
    `  size year 3            ${fmt(db.gbYear3, 1)} GB`,
    `  size per card          ${fmt(db.gbPerCard, 4)} GB`,
    "",
    "Connections",
    `  peak RPS (burst)       ${fmt(connections.peakRpsBurst, 1)}`,
    `  DB-bound RPS           ${fmt(connections.dbBoundRps, 1)}`,
    `  concurrent DB requests ${fmt(connections.concurrentDbRequests, 1)}`,
    `  pooler connections     ${fmt(connections.poolerConnections)} / ${fmt(connections.poolerCeiling)}`,
    "",
    "Stellar RPC",
    `  calls / month          ${fmt(rpc.callsPerMonth)}`,
    `  peak calls / second    ${fmt(rpc.callsPerSecondPeak, 1)}`,
    "",
    "SMS",
    `  messages / month       ${fmt(sms.messagesPerMonth)}`,
    `  cost / month           $${fmt(sms.costPerMonthUsd)}`,
    "",
    "Storage",
    `  year 1                 ${fmt(storage.gbYear1, 1)} GB`,
    `  year 3                 ${fmt(storage.gbYear3, 1)} GB`,
    "",
    "Serverless",
    `  invocations / month    ${fmt(serverless.invocationsPerMonth)}`,
    `  compute cost / month   $${fmt(serverless.costPerMonthUsd)}`,
    `  egress / month         ${fmt(serverless.egressGbPerMonth, 1)} GB ($${fmt(serverless.egressCostPerMonthUsd)})`,
    "",
    `Monthly run rate         $${fmt(model.monthlyRunRateUsd)}`,
    `Annual run rate          $${fmt(model.annualRunRateUsd)}`,
    "",
    "Top bottlenecks (projected / ceiling)",
  ];
  for (const b of model.bottlenecks) {
    const flag = b.utilization >= 1 ? "BREACH" : `${fmt(b.utilization * 100)}%`;
    lines.push(
      `  ${b.label.padEnd(38)} ${fmt(b.projected, 1)} / ${fmt(b.ceiling)} ${b.unit}  ${flag}`,
    );
    lines.push(`    → ${b.mitigation}`);
  }
  console.log(lines.join("\n"));
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: node perf/capacity-model.mjs [--key=value ...] [--json]\n" +
        "Assumptions: perf/capacity-assumptions.json (see docs/capacity-model.md).",
    );
    return 0;
  }
  const assumptions = flatten(loadAssumptions());
  const overrides = parseOverrides(argv);
  for (const key of Object.keys(overrides)) {
    if (!(key in assumptions)) {
      throw new Error(`unknown assumption "${key}" — see perf/capacity-assumptions.json`);
    }
  }
  const model = buildModel({ ...assumptions, ...overrides });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(model, null, 2));
  } else {
    printReport(model);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`capacity-model: ${error.message}`);
    process.exitCode = 1;
  }
}
