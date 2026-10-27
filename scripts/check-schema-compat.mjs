import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Schema-evolution gate for `contracts/*.schema.json` (Issue #776).
 *
 * Each change between two schema revisions is classified by JSON Schema
 * semantics:
 *   - backward: data valid under the OLD schema is still valid under the NEW
 *     one (new readers accept old writers);
 *   - forward: data valid under the NEW schema is valid under the OLD one
 *     (deployed readers accept new writers).
 * A change that is both is "compatible"; neither is "breaking".
 *
 * Policy: a breaking change to an already-published `-vN.schema.json` file
 * fails. Breaking changes must ship as a new `-vN+1.schema.json` file with a
 * `contracts/CHANGELOG.md` entry naming it. Where backward compatibility is
 * claimed, the previous revision's test vector must validate against the new
 * schema.
 */

const BOTH = { backward: true, forward: true };
const BACKWARD = { backward: true, forward: false };
const FORWARD = { backward: false, forward: true };
const NEITHER = { backward: false, forward: false };

const LOWER_BOUNDS = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "minProperties",
];
const UPPER_BOUNDS = [
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "maxProperties",
];

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function typesOf(schema) {
  if (schema.type === undefined) return null;
  return new Set([schema.type].flat());
}

function isSubset(a, b) {
  return [...a].every((value) => b.has(value));
}

/** Classifies how replacing `before` with `after` (a value set) affects data. */
function setChange(before, after) {
  if (before === null && after === null) return BOTH;
  if (after === null) return BACKWARD; // constraint removed
  if (before === null) return FORWARD; // constraint added
  const widened = isSubset(before, after);
  const narrowed = isSubset(after, before);
  if (widened && narrowed) return BOTH;
  if (widened) return BACKWARD;
  if (narrowed) return FORWARD;
  return NEITHER;
}

function enumSet(schema) {
  return schema.enum === undefined
    ? null
    : new Set(schema.enum.map((value) => JSON.stringify(value)));
}

function allowsExtra(schema) {
  return schema.additionalProperties !== false;
}

/**
 * Returns every change between two schemas as
 * `{ path, kind, backward, forward }`.
 */
export function diffSchemas(before, after, path = "$") {
  const changes = [];
  const push = (kind, effect) => changes.push({ path, kind, ...effect });

  const typeEffect = setChange(typesOf(before), typesOf(after));
  if (!same(before.type, after.type)) push("type", typeEffect);

  if (!same(before.enum, after.enum)) {
    push("enum", setChange(enumSet(before), enumSet(after)));
  }

  if (!same(before.const, after.const)) {
    if (before.const === undefined) push("const-added", FORWARD);
    else if (after.const === undefined) push("const-removed", BACKWARD);
    else push("const-changed", NEITHER);
  }

  for (const key of LOWER_BOUNDS) {
    if (same(before[key], after[key])) continue;
    if (
      after[key] === undefined ||
      (before[key] !== undefined && after[key] < before[key])
    ) {
      push(`${key}-loosened`, BACKWARD);
    } else push(`${key}-tightened`, FORWARD);
  }
  for (const key of UPPER_BOUNDS) {
    if (same(before[key], after[key])) continue;
    if (
      after[key] === undefined ||
      (before[key] !== undefined && after[key] > before[key])
    ) {
      push(`${key}-loosened`, BACKWARD);
    } else push(`${key}-tightened`, FORWARD);
  }

  if (!same(before.pattern, after.pattern)) {
    if (before.pattern === undefined) push("pattern-added", FORWARD);
    else if (after.pattern === undefined) push("pattern-removed", BACKWARD);
    else push("pattern-changed", NEITHER);
  }

  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};

  for (const name of afterRequired) {
    if (beforeRequired.has(name)) continue;
    // Old data may lack the field. New data carries it, which an old reader
    // accepts only if it already knew the property or allowed extras.
    const oldAccepts = name in beforeProps || allowsExtra(before);
    push(`required-added:${name}`, oldAccepts ? FORWARD : NEITHER);
  }
  for (const name of beforeRequired) {
    if (!afterRequired.has(name)) push(`required-removed:${name}`, BACKWARD);
  }

  for (const name of Object.keys(afterProps)) {
    if (name in beforeProps) {
      changes.push(
        ...diffSchemas(beforeProps[name], afterProps[name], `${path}.${name}`),
      );
    } else if (!afterRequired.has(name)) {
      push(`property-added:${name}`, allowsExtra(before) ? BOTH : BACKWARD);
    }
  }
  for (const name of Object.keys(beforeProps)) {
    if (name in afterProps) continue;
    push(`property-removed:${name}`, allowsExtra(after) ? BOTH : FORWARD);
  }

  if (!same(before.additionalProperties, after.additionalProperties)) {
    if (after.additionalProperties === false)
      push("additionalProperties-closed", FORWARD);
    else if (before.additionalProperties === false)
      push("additionalProperties-opened", BACKWARD);
    else push("additionalProperties-changed", NEITHER);
  }

  if (!same(before.items, after.items)) {
    if (before.items === undefined) push("items-added", FORWARD);
    else if (after.items === undefined) push("items-removed", BACKWARD);
    else changes.push(...diffSchemas(before.items, after.items, `${path}[]`));
  }

  return changes;
}

/** Overall verdict: "compatible" | "backward-only" | "forward-only" | "breaking". */
export function classify(before, after) {
  const changes = diffSchemas(before, after);
  const backward = changes.every((change) => change.backward);
  const forward = changes.every((change) => change.forward);
  const verdict =
    backward && forward
      ? "compatible"
      : backward
        ? "backward-only"
        : forward
          ? "forward-only"
          : "breaking";
  return { verdict, changes };
}

/** Minimal validator for the JSON Schema keywords the contracts use. */
export function validate(schema, value, path = "$") {
  const errors = [];
  const types = typesOf(schema);
  const actual = Array.isArray(value)
    ? "array"
    : value === null
      ? "null"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;
  if (
    types &&
    !types.has(actual) &&
    !(actual === "integer" && types.has("number"))
  ) {
    return [`${path}: expected ${[...types].join("|")}, got ${actual}`];
  }
  if (schema.const !== undefined && !same(schema.const, value)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((option) => same(option, value))) {
    errors.push(`${path}: value not in enum`);
  }
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value))
      errors.push(`${path}: pattern mismatch`);
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path}: too long`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: too many items`);
    if (schema.items)
      value.forEach((item, i) =>
        errors.push(...validate(schema.items, item, `${path}[${i}]`)),
      );
  }
  if (actual === "object") {
    for (const name of schema.required ?? []) {
      if (!(name in value)) errors.push(`${path}: missing required "${name}"`);
    }
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(value)) {
      if (name === "$schema") continue;
      if (name in properties)
        errors.push(...validate(properties[name], child, `${path}.${name}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unexpected "${name}"`);
      else if (typeof schema.additionalProperties === "object") {
        errors.push(
          ...validate(schema.additionalProperties, child, `${path}.${name}`),
        );
      }
    }
  }
  return errors;
}

function gitShow(ref, path) {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const SCHEMA_RE = /^(.*)-v(\d+)\.schema\.json$/;

/** Runs the gate for every schema in `directory` against git `baseRef`. */
export function checkContracts(directory, baseRef) {
  const failures = [];
  const report = [];
  const changelogPath = join(directory, "CHANGELOG.md");
  const changelog = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "";

  for (const file of readdirSync(directory)
    .filter((name) => SCHEMA_RE.test(name))
    .sort()) {
    const [, stem, version] = file.match(SCHEMA_RE);
    const current = JSON.parse(readFileSync(join(directory, file), "utf8"));
    const vectorFile = `${stem}-v${version}.json`;
    const vectorPath = join(directory, vectorFile);

    // The current vector must always validate against its own schema.
    if (existsSync(vectorPath)) {
      for (const error of validate(
        current,
        JSON.parse(readFileSync(vectorPath, "utf8")),
      )) {
        failures.push(`${vectorFile}: ${error}`);
      }
    }

    const previousText = gitShow(baseRef, `${directory}/${file}`);
    if (previousText === null) {
      // New file: a version bump must be documented in the changelog.
      if (Number(version) > 1 && !changelog.includes(file)) {
        failures.push(
          `${file}: new schema version needs a contracts/CHANGELOG.md entry naming it`,
        );
      }
      report.push(`${file}: new`);
      continue;
    }

    const { verdict, changes } = classify(JSON.parse(previousText), current);
    report.push(`${file}: ${verdict}`);
    for (const change of changes) {
      report.push(
        `  ${change.path} ${change.kind} (backward=${change.backward}, forward=${change.forward})`,
      );
    }
    if (verdict === "breaking") {
      failures.push(
        `${file}: breaking change to a published schema; add ${stem}-v${Number(version) + 1}.schema.json and a CHANGELOG entry instead`,
      );
    }
    if (verdict === "compatible" || verdict === "backward-only") {
      const previousVector = gitShow(baseRef, `${directory}/${vectorFile}`);
      if (previousVector !== null) {
        for (const error of validate(current, JSON.parse(previousVector))) {
          failures.push(
            `${vectorFile}@${baseRef}: ${error} (backward compatibility claimed)`,
          );
        }
      }
    }
  }
  return { failures, report };
}

function main() {
  const baseIndex = process.argv.indexOf("--base");
  const baseRef =
    baseIndex === -1 ? "origin/main" : process.argv[baseIndex + 1];
  const { failures, report } = checkContracts("contracts", baseRef);
  console.log(report.join("\n"));
  if (failures.length > 0) {
    console.error("\nContract schema compatibility check failed:");
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log("\nContract schemas are compatible with", baseRef);
}

// Only run as a CLI when executed directly — not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
