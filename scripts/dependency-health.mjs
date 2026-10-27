#!/usr/bin/env node
// Dependency health report for direct production dependencies (issue #810).
//
// Flags packages with a low OpenSSF Scorecard score, no release within the
// staleness window, or a single maintainer. Packages listed in
// security/dependency-health-allowlist.json are reported but not failed.
//
//   node scripts/dependency-health.mjs                 # all direct deps
//   node scripts/dependency-health.mjs --base <ref>    # only deps added vs ref
//   --markdown <file>  write a Markdown summary (PR comment / step summary)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const base = arg("--base");
const markdownPath = arg("--markdown");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const allowlist = JSON.parse(
  readFileSync("security/dependency-health-allowlist.json", "utf8"),
);
const { minScorecard, maxDaysSincePublish, minMaintainers } =
  allowlist.thresholds;
const excepted = new Map(allowlist.exceptions.map((e) => [e.package, e]));

let names = Object.keys(pkg.dependencies ?? {});
if (base) {
  const basePkg = JSON.parse(
    execFileSync("git", ["show", `${base}:package.json`], { encoding: "utf8" }),
  );
  const existing = new Set(Object.keys(basePkg.dependencies ?? {}));
  names = names.filter((n) => !existing.has(n));
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

function repoSlug(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  const m = url?.match(/github\.com[/:]([^/]+\/[^/#.]+)/);
  return m?.[1];
}

async function inspect(name) {
  const meta = await getJson(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
  );
  if (!meta) return { name, problems: ["registry metadata unavailable"] };
  const latest = meta["dist-tags"]?.latest;
  const published = meta.time?.[latest];
  const days = published
    ? Math.floor((Date.now() - Date.parse(published)) / 86_400_000)
    : undefined;
  const maintainers = meta.maintainers?.length ?? 0;
  const slug = repoSlug(meta.versions?.[latest]?.repository ?? meta.repository);
  const sc = slug
    ? await getJson(`https://api.securityscorecards.dev/projects/github.com/${slug}`)
    : undefined;
  const score = sc?.score;

  const problems = [];
  if (score === undefined) problems.push("no Scorecard result");
  else if (score < minScorecard) problems.push(`Scorecard ${score} < ${minScorecard}`);
  if (days === undefined || days > maxDaysSincePublish)
    problems.push(`last release ${days ?? "?"} days ago`);
  if (maintainers < minMaintainers) problems.push(`${maintainers} maintainer(s)`);
  return { name, score, days, maintainers, problems };
}

const results = await Promise.all(names.map(inspect));
const failing = results.filter((r) => r.problems.length && !excepted.has(r.name));

const rows = results.map((r) => {
  const status = !r.problems.length
    ? "ok"
    : excepted.has(r.name)
      ? `allowlisted (${excepted.get(r.name).reason})`
      : "**needs justification**";
  return `| \`${r.name}\` | ${r.score ?? "–"} | ${r.days ?? "–"} | ${r.maintainers ?? "–"} | ${r.problems.join("; ") || "–"} | ${status} |`;
});
const markdown = [
  "### Dependency health",
  base
    ? `New direct production dependencies vs \`${base}\`: ${names.length}`
    : `Direct production dependencies: ${names.length}`,
  "",
  `Thresholds: Scorecard ≥ ${minScorecard}, released within ${maxDaysSincePublish} days, ≥ ${minMaintainers} maintainers.`,
  "",
  ...(rows.length
    ? [
        "| Package | Scorecard | Days since release | Maintainers | Findings | Status |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows,
      ]
    : ["No dependencies to review."]),
  "",
  failing.length
    ? "Packages below threshold must be justified in `security/dependency-health-allowlist.json` (see `docs/operations/dependency-health.md`)."
    : "",
].join("\n");

if (markdownPath) writeFileSync(markdownPath, markdown);
console.log(markdown);
if (failing.length) process.exitCode = 1;
