#!/usr/bin/env node
/**
 * Feature-flag lifecycle check (issue #788).
 *
 *  - Warns (GitHub annotation) on code references to flags missing from
 *    FLAG_REGISTRY in lib/flags.ts.
 *  - Reports release/experiment flags past their expiry date, listing the
 *    code references found by the static scan.
 *  - With --create-issues, opens one tracking issue per expired flag via the
 *    `gh` CLI (skipped when an open issue with the same title exists).
 *
 * Exit code is 0 unless --strict is passed and a problem is found.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "lib", "components", "proxy.ts"];
const REF_PATTERN = /\b(?:isEnabled|getFlagState)\(\s*['"]([a-z0-9_]+)['"]/g;
const ENTRY_PATTERN =
  /^\s*([a-z0-9_]+):\s*\{\s*owner:\s*'([^']+)',\s*kind:\s*'([a-z_]+)',\s*expiresAt:\s*(null|'(\d{4}-\d{2}-\d{2})')\s*\}/gm;

const args = new Set(process.argv.slice(2));

export function parseRegistry(source) {
  const block =
    source.split("export const FLAG_REGISTRY")[1]?.split("};")[0] ?? "";
  const registry = new Map();
  for (const m of block.matchAll(ENTRY_PATTERN)) {
    registry.set(m[1], { owner: m[2], kind: m[3], expiresAt: m[5] ?? null });
  }
  return registry;
}

function walk(path, out = []) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      walk(join(path, name), out);
    }
  } else if (/\.(ts|tsx|mjs|js)$/.test(path) && !/\.test\.tsx?$/.test(path)) {
    out.push(path);
  }
  return out;
}

export function scanReferences(files) {
  const refs = new Map();
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(REF_PATTERN)) {
        const list = refs.get(m[1]) ?? [];
        list.push(`${relative(ROOT, file)}:${i + 1}`);
        refs.set(m[1], list);
      }
    });
  }
  return refs;
}

function createIssue(key, meta, locations) {
  const title = `Remove expired feature flag: ${key}`;
  const existing = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number",
    ],
    { encoding: "utf8" },
  );
  if (JSON.parse(existing).length > 0) return;
  const body = [
    `The ${meta.kind} flag \`${key}\` (owner: ${meta.owner}) expired on ${meta.expiresAt}.`,
    "",
    "Code references:",
    ...(locations.length
      ? locations.map((l) => `- \`${l}\``)
      : ["- none found"]),
    "",
    "See docs/operations/feature-flags.md for the removal procedure.",
  ].join("\n");
  execFileSync("gh", ["issue", "create", "--title", title, "--body", body], {
    stdio: "inherit",
  });
}

function main() {
  const registry = parseRegistry(
    readFileSync(join(ROOT, "lib/flags.ts"), "utf8"),
  );
  const refs = scanReferences(SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))));
  const today = new Date().toISOString().slice(0, 10);
  let problems = 0;

  for (const [key, locations] of refs) {
    if (registry.has(key)) continue;
    problems++;
    for (const loc of locations) {
      const [file, line] = loc.split(":");
      console.log(
        `::warning file=${file},line=${line}::Unknown feature flag "${key}" (not in FLAG_REGISTRY)`,
      );
    }
  }

  for (const [key, meta] of registry) {
    if (meta.kind === "kill_switch") continue;
    if (!meta.expiresAt) {
      problems++;
      console.log(`::warning::Flag "${key}" (${meta.kind}) has no expiresAt`);
      continue;
    }
    if (meta.expiresAt >= today) continue;
    problems++;
    const locations = refs.get(key) ?? [];
    console.log(
      `::warning::Flag "${key}" expired on ${meta.expiresAt}; references: ${locations.join(", ") || "none"}`,
    );
    if (args.has("--create-issues")) createIssue(key, meta, locations);
  }

  console.log(
    `Checked ${registry.size} registered flags; ${problems} problem(s).`,
  );
  if (args.has("--strict") && problems > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
