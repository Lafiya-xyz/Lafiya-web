#!/usr/bin/env node
/**
 * scripts/check-ops-runbooks.mjs (issue #947)
 *
 * Keeps the operator CLI and the runbooks in docs/operations/ in sync:
 *
 *  1. docs/operations/operator-cli.md must equal `node lib/ops/cli.ts docs`
 *     (renaming a command without regenerating the docs fails CI).
 *  2. Every `npm run ops -- <command> ...` invocation found in docs/operations/
 *     must reference a command that still exists in COMMANDS.
 *  3. Every command in COMMANDS must be documented in at least one runbook.
 *
 * Usage:
 *   node scripts/check-ops-runbooks.mjs           # check
 *   node scripts/check-ops-runbooks.mjs --write   # regenerate operator-cli.md
 *
 * Exit codes: 0 — in sync, 1 — drift found.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const OPS_DIR = join(ROOT, "docs", "operations");
const CLI_DOC = join(OPS_DIR, "operator-cli.md");

const { COMMANDS, renderDocs } = await import(
  new URL("../lib/ops/cli.ts", import.meta.url).href
);

const write = process.argv.includes("--write");
const errors = [];

// ─── 1. Generated CLI reference ───────────────────────────────────────────────
const expected = renderDocs();
const actual = readFileSync(CLI_DOC, "utf8");
if (write) {
  if (actual !== expected) writeFileSync(CLI_DOC, expected);
} else if (actual !== expected) {
  errors.push(
    "docs/operations/operator-cli.md is out of date — run `node scripts/check-ops-runbooks.mjs --write`",
  );
}

// ─── 2. Runbook invocations reference real commands ───────────────────────────
const INVOCATION_RE = /npm run ops -- ([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)/g;
const runbooks = readdirSync(OPS_DIR).filter(
  (f) => f.endsWith(".md") && f !== "operator-cli.md",
);
const documented = new Set();

for (const file of runbooks) {
  const body = readFileSync(join(OPS_DIR, file), "utf8");
  for (const match of body.matchAll(INVOCATION_RE)) {
    const command = match[1];
    documented.add(command);
    if (!COMMANDS[command]) {
      errors.push(
        `docs/operations/${file} invokes unknown command \`${command}\` (renamed or removed?)`,
      );
    }
  }
}

// ─── 3. Every command is documented somewhere ────────────────────────────────
for (const command of Object.keys(COMMANDS)) {
  if (!documented.has(command)) {
    errors.push(
      `command \`${command}\` is not referenced by any runbook in docs/operations/`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
console.log("✓ operator CLI and runbooks are in sync");
