#!/usr/bin/env node
/**
 * Clinical hazard log validation and safety-case report (issue #924).
 *
 *   node scripts/check-hazards.mjs            # validate (CI gate)
 *   node scripts/check-hazards.mjs --report   # validate + write the report
 *
 * Validation is schema-driven (safety/hazards.schema.json) and additionally
 * checks referential integrity: unique hazard/control ids, and every control
 * test path must exist in the repository. The report is a deterministic
 * Markdown safety case written to artifacts/clinical-safety-case.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HAZARDS_PATH = "safety/hazards.yaml";
export const SCHEMA_PATH = "safety/hazards.schema.json";
export const REPORT_PATH = "artifacts/clinical-safety-case.md";

/** Minimal YAML subset parser: block maps, block sequences, scalars, and
 * `>`/`|` block scalars. Sufficient for the hazard log and dependency-free. */
export function parseYaml(source) {
  const lines = source
    .split(/\r?\n/)
    .map((raw) => ({ raw, text: stripComment(raw) }))
    .filter(({ text }) => text.trim().length > 0);
  let index = 0;

  const indentOf = (text) => text.length - text.trimStart().length;

  function parseBlockScalar(indent) {
    const parts = [];
    while (index < lines.length && indentOf(lines[index].text) > indent) {
      parts.push(lines[index].text.trim());
      index += 1;
    }
    return parts.join(" ").trim();
  }

  function parseScalar(value, indent) {
    const trimmed = value.trim();
    if (trimmed === ">" || trimmed === "|") return parseBlockScalar(indent);
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return JSON.parse(trimmed);
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replaceAll("''", "'");
    }
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null" || trimmed === "~") return null;
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  }

  function parseNode(indent) {
    if (index >= lines.length) return null;
    const first = lines[index].text;
    if (first.trimStart().startsWith("- ")) return parseSequence(indent);
    return parseMapping(indent);
  }

  function parseSequence(indent) {
    const items = [];
    while (index < lines.length) {
      const text = lines[index].text;
      if (indentOf(text) !== indent || !text.trimStart().startsWith("- ")) break;
      const rest = text.trimStart().slice(2);
      if (rest.trim().length === 0) {
        index += 1;
        items.push(parseNode(indent + 2));
        continue;
      }
      if (/^[A-Za-z0-9_-]+:(\s|$)/.test(rest)) {
        // Inline first key of a mapping item: re-indent it as a mapping line.
        lines[index] = {
          raw: lines[index].raw,
          text: " ".repeat(indent + 2) + rest,
        };
        items.push(parseMapping(indent + 2));
        continue;
      }
      items.push(parseScalar(rest, indent));
      index += 1;
    }
    return items;
  }

  function parseMapping(indent) {
    const map = {};
    while (index < lines.length) {
      const text = lines[index].text;
      if (indentOf(text) !== indent) break;
      const match = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(text.trim());
      if (!match) break;
      const key = match[1];
      const value = match[2] ?? "";
      index += 1;
      if (value.trim().length === 0) {
        const next = lines[index];
        map[key] =
          next && indentOf(next.text) > indent ? parseNode(indentOf(next.text)) : null;
      } else {
        map[key] = parseScalar(value, indent);
      }
    }
    return map;
  }

  return parseNode(indentOf(lines[0]?.text ?? ""));
}

function stripComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1])) return raw.slice(0, i);
    }
  }
  return raw;
}

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates `value` against the JSON-Schema subset used by the hazard log. */
export function validateSchema(value, schema, path = "$", root = schema) {
  const errors = [];
  if (schema.$ref) {
    const target = schema.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce((node, key) => node?.[key], root);
    return validateSchema(value, target, path, root);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  }
  if (schema.type === "object") {
    if (!isObject(value)) return [...errors, `${path}: must be an object`];
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) {
          errors.push(`${path}.${key}: is not allowed`);
        }
        continue;
      }
      errors.push(...validateSchema(child, property, `${path}.${key}`, root));
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [...errors, `${path}: must be an array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} item(s)`);
    }
    value.forEach((item, i) => {
      errors.push(...validateSchema(item, schema.items, `${path}[${i}]`, root));
    });
  } else if (schema.type === "string") {
    if (typeof value !== "string") return [...errors, `${path}: must be a string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} character(s)`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: must match ${schema.pattern}`);
    }
    if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      errors.push(`${path}: must be an ISO date (YYYY-MM-DD)`);
    }
  }
  return errors;
}

/** Cross-field checks the schema cannot express. */
export function validateHazardLog(log, { fileExists = existsSync } = {}) {
  const errors = [];
  const hazardIds = new Set();
  const controlIds = new Set();
  for (const [i, hazard] of (log.hazards ?? []).entries()) {
    if (hazardIds.has(hazard.id)) errors.push(`hazards[${i}].id: duplicate ${hazard.id}`);
    hazardIds.add(hazard.id);
    for (const [j, control] of (hazard.controls ?? []).entries()) {
      if (controlIds.has(control.id)) {
        errors.push(`hazards[${i}].controls[${j}].id: duplicate ${control.id}`);
      }
      controlIds.add(control.id);
      for (const test of control.tests ?? []) {
        if (!fileExists(test)) {
          errors.push(
            `hazards[${i}].controls[${j}].tests: missing test file ${test}`,
          );
        }
      }
    }
  }
  return errors;
}

const RISK_ORDER = { high: 0, medium: 1, low: 2 };

/** Deterministic Markdown safety-case report for a release artefact. */
export function buildSafetyCaseReport(log, { generatedAt } = {}) {
  const hazards = [...(log.hazards ?? [])].sort(
    (a, b) =>
      (RISK_ORDER[a.risk_level] ?? 9) - (RISK_ORDER[b.risk_level] ?? 9) ||
      a.id.localeCompare(b.id),
  );
  const controls = hazards.flatMap((hazard) => hazard.controls ?? []);
  const lines = [
    "# Clinical safety case",
    "",
    `- Hazard log version: ${log.version}`,
    `- Last reviewed: ${log.last_reviewed}`,
    `- Clinical reviewer: ${log.clinical_reviewer}`,
    `- Generated: ${generatedAt ?? "not recorded"}`,
    `- Hazards: ${hazards.length} (${hazards.filter((h) => h.risk_level === "high").length} high)`,
    `- Controls: ${controls.length}`,
    "",
    "## Hazard summary",
    "",
    "| Hazard | Title | Severity | Likelihood | Risk | Residual | Status |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...hazards.map(
      (h) =>
        `| ${h.id} | ${h.title} | ${h.severity} | ${h.likelihood} | ${h.risk_level} | ${h.residual_risk} | ${h.status} |`,
    ),
    "",
    "## Controls and evidence",
    "",
  ];
  for (const hazard of hazards) {
    lines.push(`### ${hazard.id} — ${hazard.title}`, "");
    for (const control of hazard.controls ?? []) {
      lines.push(
        `- **${control.id}** (${control.type}): ${control.description}`,
        `  - Evidence: ${control.tests.map((t) => `\`${t}\``).join(", ")}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function main(argv) {
  const root = process.cwd();
  const log = parseYaml(readFileSync(join(root, HAZARDS_PATH), "utf8"));
  const schema = JSON.parse(readFileSync(join(root, SCHEMA_PATH), "utf8"));
  const errors = [
    ...validateSchema(log, schema),
    ...validateHazardLog(log, {
      fileExists: (path) => existsSync(join(root, path)),
    }),
  ];
  if (errors.length > 0) {
    for (const error of errors) console.error(`${HAZARDS_PATH}: ${error}`);
    console.error(`\n${errors.length} hazard-log error(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`Hazard log OK: ${log.hazards.length} hazard(s).`);
  if (argv.includes("--report")) {
    const report = buildSafetyCaseReport(log, {
      generatedAt: process.env.SAFETY_CASE_GENERATED_AT ?? new Date().toISOString(),
    });
    const out = join(root, REPORT_PATH);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, report);
    console.log(`Wrote ${REPORT_PATH}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
