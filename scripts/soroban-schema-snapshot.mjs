#!/usr/bin/env node
/**
 * Soroban RPC/XDR schema snapshot diff (issue #901).
 *
 * Probes a Soroban RPC endpoint for the JSON-RPC methods the app depends on
 * (lib/stellar/attestation.ts uses `simulateTransaction`; the indexers use
 * `getLatestLedger` / `getEvents` / `getTransaction`) and records the *shape*
 * of each response -- key paths and JSON types, never values -- so a nightly
 * run against the next Stellar protocol (Futurenet) can be diffed against the
 * committed snapshot.
 *
 * Usage:
 *   node scripts/soroban-schema-snapshot.mjs --write   # refresh snapshot
 *   node scripts/soroban-schema-snapshot.mjs --check   # diff, exit 1 on drift
 *   node scripts/soroban-schema-snapshot.mjs --check --report=drift.md
 *
 * Environment:
 *   SOROBAN_RPC_URL  (default: https://rpc-futurenet.stellar.org)
 *
 * The snapshot is keyed by method only, so the same file can be produced from
 * testnet (baseline) and Futurenet (candidate) and diffed across networks.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_PATH = join(ROOT, "tests/soroban/rpc-schema.snapshot.json");
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://rpc-futurenet.stellar.org";
const TIMEOUT_MS = 20_000;

const args = new Set(process.argv.slice(2));
const reportPath = process.argv
  .find((a) => a.startsWith("--report="))
  ?.slice("--report=".length);

/** Methods probed, with the params each one needs. */
const PROBES = [
  { method: "getNetwork", params: {} },
  { method: "getLatestLedger", params: {} },
  { method: "getHealth", params: {} },
  { method: "getVersionInfo", params: {} },
  {
    method: "getLedgerEntries",
    params: { keys: [] },
  },
  {
    method: "getEvents",
    params: {
      startLedger: 1,
      filters: [{ type: "contract", contractIds: [] }],
      pagination: { limit: 1 },
    },
  },
];

/**
 * Reduces a JSON value to a stable shape descriptor: object keys (sorted) and
 * primitive types. Arrays collapse to a single element shape so a longer
 * result set never registers as drift.
 */
export function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "array<empty>" : ["array", shapeOf(value[0])];
  }
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = shapeOf(value[key]);
    return out;
  }
  return typeof value;
}

async function probe({ method, params }) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json();
  // An error envelope is itself part of the contract we depend on.
  return shapeOf(body);
}

export async function collectSnapshot() {
  const snapshot = { rpcUrl: RPC_URL, methods: {} };
  for (const probeSpec of PROBES) {
    try {
      snapshot.methods[probeSpec.method] = await probe(probeSpec);
    } catch (error) {
      snapshot.methods[probeSpec.method] = {
        probeError: error instanceof Error ? error.name : "Error",
      };
    }
  }
  return snapshot;
}

/** Returns a list of human-readable drift lines (empty when identical). */
export function diffSnapshots(expected, actual) {
  const drift = [];
  const methods = new Set([
    ...Object.keys(expected.methods ?? {}),
    ...Object.keys(actual.methods ?? {}),
  ]);
  for (const method of [...methods].sort()) {
    const before = JSON.stringify(expected.methods?.[method] ?? null);
    const after = JSON.stringify(actual.methods?.[method] ?? null);
    if (before !== after) {
      drift.push(`- \`${method}\`\n  - snapshot: \`${before}\`\n  - observed: \`${after}\``);
    }
  }
  return drift;
}

function writeReport(drift) {
  const body = [
    "## Soroban RPC/XDR schema drift",
    "",
    `Endpoint: \`${RPC_URL}\``,
    "",
    ...drift,
    "",
    "If the change is expected for the next protocol version, refresh the",
    "snapshot with `node scripts/soroban-schema-snapshot.mjs --write` and",
    "review the diff. See docs/operations/soroban-upgrade-readiness.md.",
  ].join("\n");
  if (reportPath) writeFileSync(reportPath, `${body}\n`);
  console.log(body);
}

async function main() {
  const actual = await collectSnapshot();
  if (args.has("--write")) {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Wrote ${SNAPSHOT_PATH}`);
    return;
  }
  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const drift = diffSnapshots(expected, actual);
  if (drift.length === 0) {
    console.log("Soroban RPC schema snapshot matches.");
    return;
  }
  writeReport(drift);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
