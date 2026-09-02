#!/usr/bin/env node
/**
 * scripts/check-adr-template.mjs
 *
 * Verifies that every ADR in docs/ (files matching adr-*.md) contains the
 * required sections. Exits non-zero and prints the missing sections if any
 * ADR does not conform.
 *
 * Required sections (case-insensitive heading match):
 *   - Status     — e.g. "## Status" or bold "**Status:**" at the top
 *   - Decision   — the core decision and rationale
 *   - Consequences — trade-offs, limitations, and downstream effects
 *
 * Usage:
 *   node scripts/check-adr-template.mjs
 *
 * Exit codes:
 *   0 — all ADRs conform
 *   1 — one or more ADRs are missing required sections
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DOCS_DIR = join(ROOT, "docs");

// Required sections — matched against headings (## Heading) or bold key-value
// pairs (**Key:** …) at the start of a line (case-insensitive).
const REQUIRED_SECTIONS = ["status", "decision", "consequences"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return the set of section names present in the given markdown content. */
function extractSections(content) {
  const found = new Set();

  // Match ATX headings: ## Section Name
  for (const match of content.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    found.add(match[1].trim().toLowerCase());
  }

  // Match bold key-value pairs at line start: **Status:** … or **Status**
  for (const match of content.matchAll(/^\*\*([^*]+?)(?::)?\*\*/gm)) {
    found.add(match[1].trim().toLowerCase());
  }

  // Also match inline "Status: accepted" lines or list items "- Status: ..."
  for (const match of content.matchAll(/^[-*\s]*\b(status|decision|consequences)\s*:/gim)) {
    found.add(match[1].trim().toLowerCase());
  }

  return found;
}

/** Return true if the required section name is satisfied by the found set. */
function sectionPresent(required, found) {
  // Allow "consequences and limitations" to satisfy "consequences"
  for (const s of found) {
    if (s === required || s.startsWith(required)) return true;
  }
  return false;
}

// ─── Collect ADR files ────────────────────────────────────────────────────────
let entries;
try {
  entries = readdirSync(DOCS_DIR, { withFileTypes: true });
} catch {
  console.error(`✗ Could not read docs/ directory at ${DOCS_DIR}`);
  process.exit(1);
}

const adrFiles = entries
  .filter(
    (e) =>
      e.isFile() &&
      e.name.toLowerCase().startsWith("adr-") &&
      e.name.endsWith(".md"),
  )
  .map((e) => join(DOCS_DIR, e.name))
  .sort();

if (adrFiles.length === 0) {
  console.log("⚠ No ADR files found in docs/.");
  process.exit(0);
}

// ─── Check each ADR ───────────────────────────────────────────────────────────
let failed = false;
const results = [];

for (const file of adrFiles) {
  const content = readFileSync(file, "utf8");
  const found = extractSections(content);
  const missing = REQUIRED_SECTIONS.filter((r) => !sectionPresent(r, found));
  results.push({ file, missing });
  if (missing.length > 0) failed = true;
}

// ─── Report ───────────────────────────────────────────────────────────────────
const label = `── ADR template check (${adrFiles.length} file${adrFiles.length === 1 ? "" : "s"})`;
console.log(`\n${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
console.log(`  Required sections: ${REQUIRED_SECTIONS.join(", ")}\n`);

for (const { file, missing } of results) {
  const relFile = file.replace(ROOT + "/", "");
  if (missing.length === 0) {
    console.log(`  ✓ ${relFile}`);
  } else {
    console.error(`  ✗ ${relFile}`);
    for (const section of missing) {
      console.error(`      Missing: "${section}"`);
    }
  }
}

console.log("");

if (failed) {
  console.error(
    "✗ One or more ADRs are missing required sections.\n" +
    "  Add the missing sections before merging. See CONTRIBUTING.md for the ADR template.\n",
  );
  process.exit(1);
} else {
  console.log("✓ All ADRs conform to the required template.\n");
  process.exit(0);
}
