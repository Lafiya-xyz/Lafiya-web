#!/usr/bin/env node
/**
 * verify-backup-drill.mjs — Issue #891
 *
 * Evaluates a cross-region encrypted backup + restore drill against the
 * RPO (<= 15 min) and RTO (<= 4 h) targets and emits a compliance evidence
 * record (CTL-016) in the format consumed by
 * scripts/collect-compliance-evidence.mjs.
 *
 * Usage:
 *   node scripts/backup/verify-backup-drill.mjs \
 *     --backup-completed-at 2026-11-25T02:00:00Z \
 *     --restore-started-at   2026-11-25T02:05:00Z \
 *     --restore-completed-at 2026-11-25T03:10:00Z \
 *     --outcome pass \
 *     --out compliance-evidence/2026-11-25/CTL-016-drill.json
 *
 * Exit codes:
 *   0  Measured RPO/RTO within targets
 *   1  Target breached (record still written, outcome "fail")
 *   2  Invalid input
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const RPO_TARGET_SECONDS = 15 * 60;
export const RTO_TARGET_SECONDS = 4 * 60 * 60;
export const CONTROL_ID = "CTL-016";
export const CONTROL_NAME =
  "Cross-region encrypted backup restore drill within RPO/RTO";

/**
 * @param {{backupCompletedAt: string, restoreStartedAt: string, restoreCompletedAt: string}} input
 */
export function measureDrill({
  backupCompletedAt,
  restoreStartedAt,
  restoreCompletedAt,
}) {
  const backup = Date.parse(backupCompletedAt);
  const started = Date.parse(restoreStartedAt);
  const completed = Date.parse(restoreCompletedAt);
  if ([backup, started, completed].some((v) => Number.isNaN(v))) {
    throw new Error("timestamps must be ISO 8601");
  }
  if (started < backup) {
    throw new Error("restore cannot start before the backup completed");
  }
  if (completed < started) {
    throw new Error("restore cannot complete before it started");
  }

  const rpoSeconds = Math.round((started - backup) / 1000);
  const rtoSeconds = Math.round((completed - started) / 1000);

  return {
    rpoSeconds,
    rtoSeconds,
    rpoTargetSeconds: RPO_TARGET_SECONDS,
    rtoTargetSeconds: RTO_TARGET_SECONDS,
    rpoWithinTarget: rpoSeconds <= RPO_TARGET_SECONDS,
    rtoWithinTarget: rtoSeconds <= RTO_TARGET_SECONDS,
  };
}

/**
 * Build the evidence record. Contains only timings and control metadata —
 * never row data, connection strings or capability tokens (PHI policy).
 */
export function buildDrillEvidence(measurement, { runId, runUrl, notes = "" }) {
  const withinTargets =
    measurement.rpoWithinTarget && measurement.rtoWithinTarget;
  return {
    controlId: CONTROL_ID,
    controlName: CONTROL_NAME,
    collectedAt: new Date().toISOString(),
    runId,
    runUrl,
    outcome: withinTargets ? "pass" : "fail",
    notes:
      notes ||
      `RPO ${measurement.rpoSeconds}s (target ${measurement.rpoTargetSeconds}s), ` +
        `RTO ${measurement.rtoSeconds}s (target ${measurement.rtoTargetSeconds}s)`,
    rpoSeconds: measurement.rpoSeconds,
    rtoSeconds: measurement.rtoSeconds,
    rpoWithinTarget: measurement.rpoWithinTarget,
    rtoWithinTarget: measurement.rtoWithinTarget,
  };
}

function arg(args, flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const backupCompletedAt = arg(args, "--backup-completed-at");
  const restoreStartedAt = arg(args, "--restore-started-at");
  const restoreCompletedAt = arg(args, "--restore-completed-at");
  const out = arg(args, "--out");

  if (!backupCompletedAt || !restoreStartedAt || !restoreCompletedAt) {
    console.error(
      "--backup-completed-at, --restore-started-at and --restore-completed-at are required",
    );
    process.exit(2);
  }

  let measurement;
  try {
    measurement = measureDrill({
      backupCompletedAt,
      restoreStartedAt,
      restoreCompletedAt,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const record = buildDrillEvidence(measurement, {
    runId: arg(args, "--run-id") ?? process.env.GITHUB_RUN_ID ?? "local",
    runUrl:
      arg(args, "--run-url") ??
      (process.env.GITHUB_RUN_ID
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : ""),
    notes: arg(args, "--notes") ?? "",
  });

  console.log(
    `RPO ${record.rpoSeconds}s (${record.rpoWithinTarget ? "ok" : "BREACH"}), ` +
      `RTO ${record.rtoSeconds}s (${record.rtoWithinTarget ? "ok" : "BREACH"})`,
  );

  if (out) {
    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
    console.log(`Evidence written to ${path}`);
  }

  process.exit(record.outcome === "pass" ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
