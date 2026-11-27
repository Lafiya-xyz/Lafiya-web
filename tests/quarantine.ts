import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Flaky-test quarantine (issue #962).
 *
 * `tests/quarantine.json` lists known-flaky tests. Quarantined tests still run,
 * but their failures are reported as warnings instead of failing the run, so a
 * flaky test cannot block the merge queue. Entries carry an owner and an expiry
 * date; `npm run quarantine:check` fails CI once an entry expires.
 *
 * Matching: an entry matches when its `file` equals the test file (repo-relative)
 * and, if `title` is set, the test name contains it.
 */
export type QuarantineEntry = {
  file: string;
  title?: string;
  owner: string;
  expires: string;
  reason?: string;
  issue?: number;
};

const QUARANTINE_PATH = path.resolve(__dirname, "quarantine.json");

export function loadQuarantine(): QuarantineEntry[] {
  if (!existsSync(QUARANTINE_PATH)) return [];
  const parsed = JSON.parse(readFileSync(QUARANTINE_PATH, "utf8"));
  return Array.isArray(parsed.tests) ? parsed.tests : [];
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function findQuarantineEntry(
  file: string,
  title: string,
  entries: QuarantineEntry[] = loadQuarantine(),
): QuarantineEntry | undefined {
  const target = normalize(file);
  return entries.find(
    (entry) =>
      normalize(entry.file) === target &&
      (!entry.title || title.includes(entry.title)),
  );
}

export function isQuarantined(
  file: string,
  title: string,
  entries: QuarantineEntry[] = loadQuarantine(),
): boolean {
  return findQuarantineEntry(file, title, entries) !== undefined;
}

export function quarantineLabel(entry: QuarantineEntry): string {
  return `quarantined (owner: @${entry.owner}, expires: ${entry.expires})`;
}
