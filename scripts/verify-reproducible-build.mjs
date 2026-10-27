#!/usr/bin/env node
/**
 * scripts/verify-reproducible-build.mjs
 *
 * Build reproducibility checks (issue #781). Client assets are everything
 * under .next/static — the files a browser downloads from /_next/static.
 *
 * Usage:
 *   node scripts/verify-reproducible-build.mjs hash [.next] [out.json]
 *       Write a sorted { "<path>": "<sha256>" } manifest of client assets.
 *
 *   node scripts/verify-reproducible-build.mjs compare a.json b.json
 *       Diff two manifests. Exit 1 if any path is missing or hash differs.
 *
 *   node scripts/verify-reproducible-build.mjs verify --url <deployment> [--commit <sha>]
 *       Compare local client assets with the ones served by a deployment.
 *       With --commit, first builds that commit in a clean git worktree
 *       (npm ci && npm run build, LAFIYA_BUILD_ID=<sha>); otherwise uses the
 *       existing .next of the current checkout. Exit 1 on any mismatch.
 *
 * See docs/reproducible-builds.md for known differences.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export function hashClientAssets(nextDir) {
  const staticDir = join(nextDir, "static");
  const manifest = {};
  for (const file of walk(staticDir).sort()) {
    manifest[relative(staticDir, file).split(sep).join("/")] = sha256(
      readFileSync(file),
    );
  }
  return manifest;
}

export function compareManifests(a, b) {
  const problems = [];
  for (const path of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(path in a)) problems.push(`only in second: ${path}`);
    else if (!(path in b)) problems.push(`only in first: ${path}`);
    else if (a[path] !== b[path]) problems.push(`hash differs: ${path}`);
  }
  return problems.sort();
}

function report(problems, okMessage) {
  if (!problems.length) {
    console.log(`✓ ${okMessage}`);
    return 0;
  }
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  console.error(`\n${problems.length} difference(s).`);
  return 1;
}

function buildCommit(commit) {
  const dir = mkdtempSync(join(tmpdir(), "lafiya-repro-"));
  execFileSync("git", ["worktree", "add", "--detach", dir, commit], {
    cwd: ROOT,
    stdio: "inherit",
  });
  const env = {
    ...process.env,
    LAFIYA_BUILD_ID: commit,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  execFileSync("npm", ["ci"], { cwd: dir, env, stdio: "inherit" });
  execFileSync("npm", ["run", "build"], { cwd: dir, env, stdio: "inherit" });
  return dir;
}

async function verifyDeployment(url, commit) {
  const dir = commit ? buildCommit(commit) : ROOT;
  try {
    const local = hashClientAssets(join(dir, ".next"));
    const problems = [];
    for (const [path, hash] of Object.entries(local)) {
      const res = await fetch(new URL(`/_next/static/${path}`, url));
      if (!res.ok) problems.push(`HTTP ${res.status}: ${path}`);
      else if (sha256(Buffer.from(await res.arrayBuffer())) !== hash)
        problems.push(`hash differs: ${path}`);
    }
    return report(
      problems,
      `${Object.keys(local).length} client assets match ${url}`,
    );
  } finally {
    if (commit) {
      execFileSync("git", ["worktree", "remove", "--force", dir], {
        cwd: ROOT,
      });
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === "hash") {
    const manifest = hashClientAssets(resolve(first ?? ".next"));
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (second) writeFileSync(second, json);
    else process.stdout.write(json);
    return 0;
  }
  if (command === "compare" && first && second) {
    const [a, b] = [first, second].map((f) =>
      JSON.parse(readFileSync(f, "utf8")),
    );
    return report(
      compareManifests(a, b),
      `${Object.keys(a).length} client assets identical`,
    );
  }
  if (command === "verify" && arg("--url")) {
    return verifyDeployment(arg("--url"), arg("--commit"));
  }
  console.error(
    "Usage: verify-reproducible-build.mjs hash [dir] [out] | compare a b | verify --url <url> [--commit <sha>]",
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
