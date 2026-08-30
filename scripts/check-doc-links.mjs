#!/usr/bin/env node
/**
 * scripts/check-doc-links.mjs
 *
 * Scans docs/*.md and README.md for relative markdown links and verifies that
 * each linked file actually exists on disk.
 *
 * External (http/https) links are intentionally skipped — they require network
 * access and are prone to transient failures.
 *
 * Usage:
 *   node scripts/check-doc-links.mjs
 *
 * Exit codes:
 *   0 — all relative links resolve to real files
 *   1 — one or more broken links found
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

// ─── Files to scan ────────────────────────────────────────────────────────────
function collectMarkdownFiles() {
  const files = [];

  // README.md at root
  const readme = join(ROOT, "README.md");
  if (existsSync(readme)) files.push(readme);

  // docs/*.md (non-recursive — subdirectories like docs/operations/ are also included)
  function scanDir(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full);
      } else if (entry.isFile() && extname(entry.name) === ".md") {
        files.push(full);
      }
    }
  }

  scanDir(join(ROOT, "docs"));

  return files;
}

// ─── Link extraction ──────────────────────────────────────────────────────────
// Matches markdown links: [text](target) and bare <target> references.
// We only care about the href/target, not the label.
const MARKDOWN_LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;

function extractRelativeLinks(content) {
  const links = [];
  let match;
  while ((match = MARKDOWN_LINK_RE.exec(content)) !== null) {
    const href = match[1].trim();
    // Strip any fragment (#section) from the href
    const withoutFragment = href.split("#")[0];
    if (!withoutFragment) continue; // pure fragment-only link, skip
    // Skip external links
    if (/^https?:\/\//i.test(withoutFragment)) continue;
    if (/^mailto:/i.test(withoutFragment)) continue;
    links.push(withoutFragment);
  }
  return links;
}

// ─── Resolution ───────────────────────────────────────────────────────────────
function resolveLink(sourceFile, href) {
  // If the path starts with / it is root-relative from the repo root
  if (href.startsWith("/")) {
    return join(ROOT, href);
  }
  // Otherwise resolve relative to the source file's directory
  return resolve(dirname(sourceFile), href);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const files = collectMarkdownFiles();
const broken = []; // { file, link, resolved }

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const links = extractRelativeLinks(content);

  for (const link of links) {
    const resolved = resolveLink(file, link);
    if (!existsSync(resolved)) {
      broken.push({ file, link, resolved });
    }
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────
const checkedCount = files.length;
console.log(`\n── Doc link check (${checkedCount} file${checkedCount === 1 ? "" : "s"} scanned) ────────────────────────────`);

if (broken.length === 0) {
  console.log("✓ All relative links resolve to existing files.\n");
  process.exit(0);
} else {
  console.error(`✗ ${broken.length} broken link${broken.length === 1 ? "" : "s"} found:\n`);
  for (const { file, link, resolved } of broken) {
    const relFile = file.replace(ROOT + "/", "");
    const relResolved = resolved.replace(ROOT + "/", "");
    console.error(`  In: ${relFile}`);
    console.error(`      Link:     ${link}`);
    console.error(`      Resolved: ${relResolved} (not found)\n`);
  }
  process.exit(1);
}
