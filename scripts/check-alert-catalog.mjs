#!/usr/bin/env node
/**
 * Alert catalog validation (issue #948).
 *
 * Every page-level alert must declare an owner and a runbook that exists in
 * the repository. Alerts without either fail validation.
 *
 * Usage:
 *   node scripts/check-alert-catalog.mjs            # validate, exit 1 on failure
 *   node scripts/check-alert-catalog.mjs --json     # machine-readable result
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CATALOG_PATH = join(ROOT, "ops/alerts/catalog.json");
const SEVERITIES = new Set(["page", "warn", "info"]);

export function validateCatalog(catalog, { fileExists = (p) => existsSync(join(ROOT, p)) } = {}) {
  const errors = [];
  const alerts = Array.isArray(catalog?.alerts) ? catalog.alerts : null;
  if (!alerts) return { ok: false, errors: ["catalog.alerts must be an array"], alerts: [] };

  const seen = new Set();
  for (const [index, alert] of alerts.entries()) {
    const where = `alerts[${index}]${alert?.id ? ` (${alert.id})` : ""}`;
    if (!alert || typeof alert.id !== "string" || !alert.id.trim()) {
      errors.push(`${where}: missing id`);
      continue;
    }
    if (seen.has(alert.id)) errors.push(`${where}: duplicate id`);
    seen.add(alert.id);
    if (!SEVERITIES.has(alert.severity)) {
      errors.push(`${where}: severity must be one of ${[...SEVERITIES].join(", ")}`);
    }
    if (alert.severity !== "page") continue;
    if (typeof alert.owner !== "string" || !alert.owner.trim()) {
      errors.push(`${where}: page-level alert has no owner`);
    }
    if (typeof alert.runbook !== "string" || !alert.runbook.trim()) {
      errors.push(`${where}: page-level alert has no runbook`);
    } else {
      const path = alert.runbook.split("#")[0];
      if (!path.endsWith(".md") || !fileExists(path)) {
        errors.push(`${where}: runbook "${alert.runbook}" does not exist`);
      }
    }
  }
  return { ok: errors.length === 0, errors, alerts };
}

function main() {
  const json = process.argv.includes("--json");
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  } catch (error) {
    console.error(`::error::Cannot read ops/alerts/catalog.json: ${error.message}`);
    process.exit(1);
  }
  const result = validateCatalog(catalog);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const error of result.errors) console.log(`::error::${error}`);
    console.log(
      `Validated ${result.alerts.length} alert(s); ${result.errors.length} problem(s).`,
    );
  }
  if (!result.ok) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
