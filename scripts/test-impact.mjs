#!/usr/bin/env node
/**
 * Issue #953: test impact analysis.
 *
 * Maps changed files to the Vitest tests and Playwright specs that can be
 * affected by them, so pull requests can run a subset of the suites. Any
 * change to shared infrastructure (config, lockfile, workflows, test
 * harnesses, migrations, ...) falls back to the full suites, and `main` /
 * nightly runs always use the full suites.
 *
 * Usage:
 *   node scripts/test-impact.mjs --base origin/main [--head HEAD]
 *       [--event pull_request|push|schedule|workflow_dispatch]
 *       [--ref refs/heads/main] [--out impact.json]
 *
 * Writes a JSON report and, when `$GITHUB_OUTPUT` is set, the outputs
 * `vitest_mode`, `vitest_args`, `playwright_mode`, `playwright_args`,
 * `full`, `reason`, `changed_count`, `vitest_count`, `playwright_count`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Files whose change invalidates every test result. */
const FULL_SUITE_PATTERNS = [
  /^package(-lock)?\.json$/,
  /^\.nvmrc$/,
  /^tsconfig(\..*)?\.json$/,
  /^vitest(\..*)?\.config\.ts$/,
  /^playwright\.config\.ts$/,
  /^next\.config\.ts$/,
  /^postcss\.config\.mjs$/,
  /^eslint\.config\.mjs$/,
  /^\.github\//,
  /^\.storybook\//,
  /^\.githooks\//,
  /^scripts\//,
  /^supabase\//,
  /^packages\//,
  /^tests\/(fixtures|setup|helpers)\//,
  /^e2e\/(fixtures|helpers|support)\//,
  /^lib\/test\//,
  /^instrumentation\.ts$/,
  /^proxy\.ts$/,
  /^sentry\..*\.config\.ts$/,
];

/** Source roots whose changes are mapped to tests by import graph. */
const SOURCE_ROOTS = ["app", "components", "lib", "hooks", "sw", "packages"];
const TEST_FILE_RE = /\.test\.(?:ts|tsx|mts)$/;
const SPEC_FILE_RE = /\.spec\.ts$/;
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\(\s*)["']([^"']+)["']/g;
const ROUTE_RE = /["'`](\/[a-z0-9\-_/[\]]*)["'`]/gi;

function toPosix(path) {
  return path.split(sep).join("/");
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function changedFiles(base, head) {
  const output = git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(toPosix);
}

function walk(directory, predicate, found = []) {
  if (!existsSync(directory)) return found;
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(directory, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, predicate, found);
    else if (predicate(full)) found.push(toPosix(relative(ROOT, full)));
  }
  return found;
}

function resolveImport(fromFile, specifier) {
  let target;
  if (specifier.startsWith("@/")) target = join(ROOT, specifier.slice(2));
  else if (specifier.startsWith(".")) target = resolve(ROOT, dirname(fromFile), specifier);
  else return null;

  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mts`,
    `${target}.js`,
    `${target}.mjs`,
    join(target, "index.ts"),
    join(target, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toPosix(relative(ROOT, candidate));
    }
  }
  return null;
}

function importsOf(file) {
  const contents = readFileSync(join(ROOT, file), "utf8");
  const imports = [];
  for (const match of contents.matchAll(IMPORT_RE)) {
    const resolved = resolveImport(file, match[1]);
    if (resolved) imports.push(resolved);
  }
  return imports;
}

/** Reverse dependency graph: file -> files that import it. */
function buildReverseGraph(files) {
  const graph = new Map();
  for (const file of files) {
    let imports = [];
    try {
      imports = importsOf(file);
    } catch {
      continue;
    }
    for (const dependency of imports) {
      if (!graph.has(dependency)) graph.set(dependency, new Set());
      graph.get(dependency).add(file);
    }
  }
  return graph;
}

function dependentsOf(graph, seeds) {
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of graph.get(current) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return seen;
}

/** Route segments a source file belongs to, e.g. `app/(auth)/profile/page.tsx`
 * -> `["/profile"]`, `app/(public)/card/[id]/page.tsx` -> `["/card"]`. */
function routeSegmentsOf(file) {
  const segments = file.split("/");
  if (segments[0] !== "app") return [];
  const route = segments
    .slice(1, -1)
    .filter((segment) => !segment.startsWith("(") && !segment.startsWith("@"));
  return route.length > 0 ? [`/${route[0]}`] : [];
}

function specRoutes(spec) {
  const contents = readFileSync(join(ROOT, spec), "utf8");
  const routes = new Set();
  for (const match of contents.matchAll(ROUTE_RE)) {
    const route = match[1].split("/").filter(Boolean)[0];
    if (route) routes.add(`/${route}`);
  }
  return routes;
}

function isFullSuiteTrigger(file) {
  return FULL_SUITE_PATTERNS.some((pattern) => pattern.test(file));
}

export function analyze({ changed, event = "pull_request", ref = "" }) {
  const fullRun = event !== "pull_request" || ref === "refs/heads/main";
  const fullTriggers = changed.filter(isFullSuiteTrigger);

  const allTests = walk(ROOT, (file) => TEST_FILE_RE.test(file));
  const allSpecs = walk(ROOT, (file) => SPEC_FILE_RE.test(file) && file.startsWith("e2e/"));

  if (fullRun || fullTriggers.length > 0) {
    return {
      full: true,
      reason: fullRun
        ? `full suite required for ${event}${ref ? ` on ${ref}` : ""}`
        : `shared infrastructure changed: ${fullTriggers.slice(0, 5).join(", ")}`,
      changed,
      vitest: allTests,
      playwright: allSpecs,
    };
  }

  const sourceFiles = walk(
    ROOT,
    (file) =>
      SOURCE_ROOTS.some((root) => file.startsWith(`${root}/`)) &&
      /\.(?:ts|tsx|mts|js|mjs)$/.test(file) &&
      !TEST_FILE_RE.test(file) &&
      !SPEC_FILE_RE.test(file),
  );
  const graph = buildReverseGraph([...sourceFiles, ...allTests]);

  const changedTests = changed.filter((file) => TEST_FILE_RE.test(file));
  const changedSources = changed.filter((file) => sourceFiles.includes(file));
  const affected = dependentsOf(graph, [...changedTests, ...changedSources]);
  const vitest = allTests.filter((file) => affected.has(file));

  const changedRoutes = new Set(changedSources.flatMap(routeSegmentsOf));
  const playwright = allSpecs.filter((spec) => {
    if (changed.includes(spec)) return true;
    const routes = specRoutes(spec);
    return [...changedRoutes].some((route) => routes.has(route));
  });

  return {
    full: false,
    reason: "affected tests only",
    changed,
    vitest,
    playwright,
  };
}

function parseArgs(argv) {
  const args = { base: "origin/main", head: "HEAD", event: "pull_request", ref: "", out: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--base") args.base = value;
    else if (key === "--head") args.head = value;
    else if (key === "--event") args.event = value;
    else if (key === "--ref") args.ref = value;
    else if (key === "--out") args.out = value;
    else continue;
    index += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const changed = changedFiles(args.base, args.head);
  const result = analyze({ changed, event: args.event, ref: args.ref });

  const report = {
    full: result.full,
    reason: result.reason,
    changed_count: changed.length,
    vitest_count: result.vitest.length,
    playwright_count: result.playwright.length,
    vitest: result.vitest,
    playwright: result.playwright,
  };

  if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  const outputs = {
    full: String(result.full),
    reason: result.reason,
    changed_count: String(changed.length),
    vitest_mode: result.full ? "full" : "affected",
    vitest_args: result.full ? "" : result.vitest.join(" "),
    vitest_count: String(result.vitest.length),
    playwright_mode: result.full ? "full" : "affected",
    playwright_args: result.full ? "" : result.playwright.join(" "),
    playwright_count: String(result.playwright.length),
  };

  if (process.env.GITHUB_OUTPUT) {
    const lines = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`);
  }

  console.log(
    `Test impact: ${outputs.vitest_mode} Vitest (${outputs.vitest_count}), ` +
      `${outputs.playwright_mode} Playwright (${outputs.playwright_count}) — ${result.reason}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
