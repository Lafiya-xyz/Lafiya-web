// OpenVEX tooling: validates the repository VEX document, gates scanner
// findings against it, and copies it into the release artefacts directory.
//
//   node scripts/vex.mjs validate [vex.json]
//   node scripts/vex.mjs gate <npm-audit.json> [vex.json]
//   node scripts/vex.mjs publish [vex.json]
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_VEX_PATH = "security/vex.openvex.json";
export const STATUSES = [
  "not_affected",
  "affected",
  "fixed",
  "under_investigation",
];
// OpenVEX v0.2.0 justification enum for `not_affected`.
export const JUSTIFICATIONS = [
  "component_not_present",
  "vulnerable_code_not_present",
  "vulnerable_code_not_in_execute_path",
  "vulnerable_code_cannot_be_controlled_by_adversary",
  "inline_mitigations_already_exist",
];
// Days an `affected` or `under_investigation` finding may stay open.
export const SLA_DAYS = { critical: 0, high: 7, moderate: 30, low: 90 };

const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;
const isTimestamp = (value) =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value));

export function validateVex(doc) {
  const errors = [];
  if (typeof doc !== "object" || doc === null)
    return ["document is not an object"];
  if (!/^https:\/\/openvex\.dev\/ns\/v0\.2\.\d+$/.test(doc["@context"] ?? ""))
    errors.push("@context must be an OpenVEX v0.2 namespace");
  if (!isNonEmptyString(doc["@id"])) errors.push("@id is required");
  if (!isNonEmptyString(doc.author)) errors.push("author is required");
  if (!isTimestamp(doc.timestamp)) errors.push("timestamp must be ISO 8601");
  if (!Number.isInteger(doc.version) || doc.version < 1)
    errors.push("version must be a positive integer");
  if (!Array.isArray(doc.statements)) {
    errors.push("statements must be an array");
    return errors;
  }

  doc.statements.forEach((statement, index) => {
    const at = `statements[${index}]`;
    const name = statement?.vulnerability?.name;
    if (!isNonEmptyString(name))
      errors.push(`${at}.vulnerability.name is required`);
    if (
      !Array.isArray(statement?.products) ||
      statement.products.length === 0 ||
      !statement.products.every((product) => isNonEmptyString(product?.["@id"]))
    )
      errors.push(`${at}.products must list at least one product @id`);
    if (!STATUSES.includes(statement?.status))
      errors.push(`${at}.status must be one of ${STATUSES.join(", ")}`);
    if (!isTimestamp(statement?.timestamp))
      errors.push(`${at}.timestamp must be ISO 8601`);
    if (statement?.status === "not_affected") {
      if (!JUSTIFICATIONS.includes(statement.justification))
        errors.push(
          `${at}.justification must be one of ${JUSTIFICATIONS.join(", ")}`,
        );
      if (!isNonEmptyString(statement.reviewer))
        errors.push(`${at}.reviewer is required for not_affected`);
    }
    if (
      statement?.status === "affected" &&
      !isNonEmptyString(statement.action_statement)
    )
      errors.push(`${at}.action_statement is required for affected`);
  });
  return errors;
}

const advisoryId = (via) =>
  /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(via.url ?? "")?.[0] ??
  `npm-${via.source}`;

// Flattens `npm audit --json` (report v2) into one finding per advisory.
export function findingsFromNpmAudit(report) {
  const findings = new Map();
  for (const vulnerability of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = advisoryId(via);
      if (!findings.has(id))
        findings.set(id, {
          id,
          package: via.name,
          severity: via.severity,
          title: via.title,
        });
    }
  }
  return [...findings.values()];
}

export function gateFindings(findings, vex, now = new Date()) {
  const statements = new Map();
  for (const statement of vex.statements ?? []) {
    const names = [
      statement.vulnerability?.name,
      ...(statement.vulnerability?.aliases ?? []),
    ];
    for (const name of names) if (name) statements.set(name, statement);
  }

  const failures = [];
  const warnings = [];
  for (const finding of findings) {
    const statement = statements.get(finding.id);
    const label = `${finding.id} (${finding.severity}, ${finding.package})`;
    if (!statement) {
      if (finding.severity === "critical")
        failures.push(`${label} has no VEX entry or fix`);
      else
        warnings.push(
          `${label} is unassessed; add a VEX entry or fix within ${SLA_DAYS[finding.severity] ?? SLA_DAYS.low} days`,
        );
      continue;
    }
    if (
      statement.status !== "affected" &&
      statement.status !== "under_investigation"
    )
      continue;
    const slaDays = SLA_DAYS[finding.severity] ?? SLA_DAYS.low;
    const ageDays =
      (now.getTime() - Date.parse(statement.timestamp)) / 86_400_000;
    if (ageDays > slaDays)
      failures.push(
        `${label} is ${statement.status} beyond its ${slaDays}-day SLA`,
      );
  }
  return { failures, warnings };
}

const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));

function loadValidVex(path) {
  const vex = readJson(path);
  const errors = validateVex(vex);
  if (errors.length > 0) {
    console.error(`Invalid VEX document ${path}:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  return vex;
}

function main([command, ...args]) {
  if (command === "validate") {
    const path = args[0] ?? DEFAULT_VEX_PATH;
    const vex = loadValidVex(path);
    console.log(
      `VEX document ${path} is valid (${vex.statements.length} statements).`,
    );
    return;
  }
  if (command === "gate" && args[0]) {
    const vex = loadValidVex(args[1] ?? DEFAULT_VEX_PATH);
    const { failures, warnings } = gateFindings(
      findingsFromNpmAudit(readJson(args[0])),
      vex,
    );
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    if (failures.length > 0) {
      console.error(`VEX gate failed:\n  ${failures.join("\n  ")}`);
      process.exit(1);
    }
    console.log("VEX gate passed.");
    return;
  }
  if (command === "publish") {
    const path = args[0] ?? DEFAULT_VEX_PATH;
    loadValidVex(path);
    mkdirSync("artifacts", { recursive: true });
    const target = join("artifacts", "lafiya-web.vex.openvex.json");
    copyFileSync(resolve(path), target);
    console.log(`Wrote OpenVEX document to ${target}`);
    return;
  }
  console.error(
    "Usage: node scripts/vex.mjs validate [vex.json] | gate <npm-audit.json> [vex.json] | publish [vex.json]",
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
