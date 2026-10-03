import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Per-directory coverage ratchet.
 *
 * Compares freshly generated Vitest coverage (coverage/coverage-summary.json)
 * against a committed baseline (coverage-baseline.json). Fails when coverage
 * drops below the baseline for any tracked directory. When running on main,
 * the baseline is updated in place so it ratchets upward automatically.
 */

const ROOT = process.cwd();
const SUMMARY_PATH = resolve(ROOT, 'coverage', 'coverage-summary.json');
const BASELINE_PATH = resolve(ROOT, 'coverage-baseline.json');

// Directories that must be tracked by the ratchet. These mirror the
// per-directory thresholds configured in vitest.config.ts.
export const TRACKED_DIRECTORIES = [
  'lib/emergency',
  'lib/attestation',
  'lib/chw-protocol',
  'lib/stellar',
] as const;

export type CoverageMetric = 'lines' | 'branches' | 'functions' | 'statements';

export interface CoverageEntry {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

export type CoverageBaseline = Record<string, CoverageEntry>;

interface IstanbulSummaryEntry {
  lines: { pct: number };
  branches: { pct: number };
  functions: { pct: number };
  statements: { pct: number };
}

type IstanbulSummary = Record<string, IstanbulSummaryEntry>;

const METRICS: CoverageMetric[] = ['lines', 'branches', 'functions', 'statements'];

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Aggregate coverage for a directory from the Istanbul-style summary produced
 * by Vitest's json-summary reporter. Files are matched by path prefix.
 */
export function aggregateDirectory(
  summary: IstanbulSummary,
  directory: string,
): CoverageEntry | null {
  const prefix = `${directory}/`;
  const matches = Object.entries(summary).filter(
    ([file]) => file !== 'total' && file.includes(prefix),
  );

  if (matches.length === 0) {
    return null;
  }

  const totals: CoverageEntry = { lines: 0, branches: 0, functions: 0, statements: 0 };
  for (const [, entry] of matches) {
    for (const metric of METRICS) {
      totals[metric] += entry[metric].pct;
    }
  }

  for (const metric of METRICS) {
    totals[metric] = round(totals[metric] / matches.length);
  }

  return totals;
}

/**
 * Build a baseline object for all tracked directories from a coverage summary.
 */
export function buildBaseline(summary: IstanbulSummary): CoverageBaseline {
  const baseline: CoverageBaseline = {};
  for (const directory of TRACKED_DIRECTORIES) {
    const entry = aggregateDirectory(summary, directory);
    if (entry) {
      baseline[directory] = entry;
    }
  }
  return baseline;
}

/**
 * Compare fresh coverage against the baseline. Returns a list of human-readable
 * regression messages. An empty array means no regressions.
 */
export function findRegressions(
  baseline: CoverageBaseline,
  current: CoverageBaseline,
): string[] {
  const regressions: string[] = [];

  for (const directory of TRACKED_DIRECTORIES) {
    const base = baseline[directory];
    const now = current[directory];

    if (!base) {
      continue;
    }

    if (!now) {
      regressions.push(`${directory}: coverage data missing (baseline ${base.lines}% lines)`);
      continue;
    }

    for (const metric of METRICS) {
      if (now[metric] < base[metric]) {
        regressions.push(
          `${directory}: ${metric} dropped from ${base[metric]}% to ${now[metric]}%`,
        );
      }
    }
  }

  return regressions;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function main(): void {
  if (!existsSync(SUMMARY_PATH)) {
    console.error(`Coverage summary not found at ${SUMMARY_PATH}. Run tests with coverage first.`);
    process.exit(1);
  }

  const summary = readJson<IstanbulSummary>(SUMMARY_PATH);
  const current = buildBaseline(summary);
  const isMain = process.env.GITHUB_REF_NAME === 'main' || process.env.CI_BRANCH === 'main';

  if (isMain) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log('Updated coverage baseline on main.');
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`Baseline not found at ${BASELINE_PATH}.`);
    process.exit(1);
  }

  const baseline = readJson<CoverageBaseline>(BASELINE_PATH);
  const regressions = findRegressions(baseline, current);

  if (regressions.length > 0) {
    console.error('Coverage ratchet failed:');
    for (const regression of regressions) {
      console.error(`  - ${regression}`);
    }
    process.exit(1);
  }

  console.log('Coverage ratchet passed.');
}

if (require.main === module) {
  main();
}
