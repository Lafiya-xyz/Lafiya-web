#!/usr/bin/env node
/**
 * Flaky-test quarantine (issue #962).
 *
 * `tests/quarantine.json` lists tests that are known-flaky. Quarantined tests
 * still run, but their failures are reported as warnings instead of failing
 * CI (see tests/quarantine.ts for the Vitest/Playwright reporters).
 *
 * This script is the CI gate:
 *  - validates every entry (file exists, owner set, expiry is a date),
 *  - fails when an entry has expired, so quarantine cannot become permanent,
 *  - with --create-issues, opens one tracking issue per quarantined test
 *    (skipped when an open issue with the same title already exists).
 *
 * Exit code is 0 unless a problem is found.
 */
import { execFileSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const QUARANTINE_PATH = join(ROOT, "tests/quarantine.json");
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const args = new Set(process.argv.slice(2));

export function loadQuarantine(path = QUARANTINE_PATH) {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(parsed.tests) ? parsed.tests : [];
}

export function validateEntries(entries, today) {
  const problems = [];
  for (const [index, entry] of entries.entries()) {
    const label = entry?.file
      ? `${entry.file}${entry.title ? ` :: ${entry.title}` : ""}`
      : `entry #${index}`;
    if (!entry?.file) problems.push(`${label}: missing "file"`);
    else if (!existsSync(join(ROOT, entry.file)))
      problems.push(`${label}: file not found`);
    if (!entry?.owner) problems.push(`${label}: missing "owner"`);
    if (!entry?.expires || !DATE_PATTERN.test(entry.expires)) {
      problems.push(`${label}: "expires" must be YYYY-MM-DD`);
    } else if (entry.expires < today) {
      problems.push(
        `${label}: quarantine expired on ${entry.expires} (owner: ${entry.owner})`,
      );
    }
  }
  return problems;
}

function issueTitle(entry) {
  return `Quarantined flaky test: ${entry.file}${entry.title ? ` :: ${entry.title}` : ""}`;
}

function createIssue(entry) {
  const title = issueTitle(entry);
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
    `\`${entry.file}\`${entry.title ? ` (\`${entry.title}\`)` : ""} is quarantined as flaky.`,
    "",
    `- Owner: @${entry.owner}`,
    `- Quarantine expires: ${entry.expires}`,
    entry.reason ? `- Reason: ${entry.reason}` : null,
    entry.issue ? `- Original report: #${entry.issue}` : null,
    "",
    "Quarantined tests still run but do not block CI. Fix or delete the test and remove its entry from `tests/quarantine.json` before the expiry date, otherwise CI fails.",
    "",
    "See docs/operations/test-quarantine.md.",
  ]
    .filter((line) => line !== null)
    .join("\n");
  execFileSync("gh", ["issue", "create", "--title", title, "--body", body], {
    stdio: "inherit",
  });
}

function main() {
  const entries = loadQuarantine();
  const today = new Date().toISOString().slice(0, 10);
  const problems = validateEntries(entries, today);

  for (const problem of problems) console.log(`::error::${problem}`);
  if (args.has("--create-issues")) {
    for (const entry of entries) {
      if (entry?.file && entry?.owner && entry?.expires) createIssue(entry);
    }
  }

  console.log(
    `Checked ${entries.length} quarantined test(s); ${problems.length} problem(s).`,
  );
  if (problems.length > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
