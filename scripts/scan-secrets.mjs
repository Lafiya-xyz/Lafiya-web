#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scan-secrets.mjs
//
// Scans staged (or explicitly listed) files for common secret patterns and
// exits non-zero with a clear report when any match is found.
//
// Designed to run as both:
//   - a pre-commit hook  (scans only git-staged changes)
//   - a CI step         (scans all files changed vs. the base branch)
//
// Usage:
//   node scripts/scan-secrets.mjs               # staged files (pre-commit)
//   node scripts/scan-secrets.mjs --all         # all tracked files
//   node scripts/scan-secrets.mjs --diff HEAD~1 # files changed since last commit
//   node scripts/scan-secrets.mjs file1 file2   # explicit file list
//
// False-positive escape hatch: add a line-level comment
//   # scan-secrets-ignore
// or
//   // scan-secrets-ignore
// to suppress a specific line.
// ---------------------------------------------------------------------------

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

// ── Secret patterns ──────────────────────────────────────────────────────────
//
// Each entry has:
//   id       – short slug used in the report
//   pattern  – RegExp tested against each non-blank, non-ignored line
//   description – human-readable description shown on a match
//
// Deliberately conservative: we match high-entropy literals, not variable
// names, so normal JS like `const SUPABASE_KEY = process.env.XXX` never fires.
// ---------------------------------------------------------------------------

const PATTERNS = [
  // Supabase service-role JWTs (eyJ prefix, role=service_role in the payload)
  {
    id: "supabase-service-role-jwt",
    pattern:
      /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
    description: "Possible Supabase / JWT bearer token (base64url-encoded JWT)",
  },

  // Generic high-entropy API keys / tokens (≥32 hex characters)
  {
    id: "hex-secret-32",
    pattern: /\b[0-9a-f]{32,64}\b/i,
    // Only flag when the surrounding context looks like an assignment or JSON
    // value, not just any long hex string (e.g. commit SHAs in comments).
    contextPattern:
      /(key|token|secret|password|passwd|api[_-]?key|access[_-]?key|auth)\s*[:=]/i,
    description: "Possible high-entropy secret (32+ hex chars in a key/token context)",
  },

  // Private key PEM block openings
  {
    id: "pem-private-key",
    pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    description: "Private key PEM block",
  },

  // AWS access key IDs (AKIA…)
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    description: "AWS access key ID (AKIA…)",
  },

  // AWS secret access keys (40-char base64 following 'aws_secret' context)
  {
    id: "aws-secret-key",
    pattern: /aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9/+]{40}/i,
    description: "AWS secret access key",
  },

  // Google API / service account keys
  {
    id: "google-api-key",
    pattern: /AIza[0-9A-Za-z_-]{35}/,
    description: "Google API key (AIza…)",
  },

  // Stellar secret keys (S… 56-char base32)
  {
    id: "stellar-secret-key",
    pattern: /\bS[A-Z2-7]{55}\b/,
    description: "Stellar secret key (S…56 chars)",
  },

  // Generic password/secret assignments with literal values
  {
    id: "password-literal",
    pattern:
      /(password|passwd|secret|token)\s*[:=]\s*['"][^'"${\s]{8,}['"]/i,
    description: "Hardcoded password or secret literal",
  },
];

// Files to always skip regardless of mode (binary, test fixtures, lock files)
const ALWAYS_SKIP = [
  /\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.png$/i,
  /\.jpg$/i,
  /\.jpeg$/i,
  /\.gif$/i,
  /\.webp$/i,
  /\.ico$/i,
  /\.woff2?$/i,
  /\.ttf$/i,
  /\.eot$/i,
  /\.pdf$/i,
  // The baseline results file contains only latency numbers — no secrets.
  /bench\/rpc-provider-benchmark\/results\//,
  // .env.example intentionally shows placeholder key formats for documentation.
  /\.env\.example$/,
  // .env.test contains only the well-known local Supabase demo keys that are
  // public knowledge (they ship in every `supabase start` instance).
  /\.env\.test$/,
  // CI workflow files contain the well-known Supabase local-dev demo JWTs
  // (public: https://supabase.com/docs/guides/cli/local-development) and
  // dummy build-time placeholder values — not real credentials.
  /\.github\/workflows\//,
  // Playwright and vitest configs embed the same well-known demo JWTs for
  // local integration test runs — not real credentials.
  /playwright\.config\./,
  /vitest\.config\./,
  /vitest\.integration\.config\./,
  // supabase/config.toml contains local-dev SMTP and dashboard passwords
  // that are intentionally public placeholders for a local instance.
  /supabase\/config\.toml$/,
  // Test helper fixtures use explicitly dummy passwords (e.g. 'lafiya-demo-password')
  // for local test accounts that never exist in production.
  /tests\/integration\/helpers\//,
  /e2e\//,
  // Unit and integration test files legitimately use dummy credential literals
  // (e.g. 'secretpassword123', 'test-password-123456') as test fixtures.
  // These are never real credentials.
  /\.test\.(ts|tsx|js|mjs)$/,
  /\.spec\.(ts|tsx|js|mjs)$/,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getStagedFiles() {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function getAllTrackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function getChangedFiles(ref) {
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMR", ref],
      { encoding: "utf8" },
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function shouldSkip(filePath) {
  return ALWAYS_SKIP.some((re) => re.test(filePath));
}

function scanFile(filePath) {
  if (!existsSync(filePath)) return [];
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    // Binary or unreadable — skip silently
    return [];
  }

  const findings = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Honour per-line suppression comments
    if (/scan-secrets-ignore/.test(line)) continue;

    for (const p of PATTERNS) {
      if (!p.pattern.test(line)) continue;
      // For patterns with a contextPattern, require additional context
      if (p.contextPattern && !p.contextPattern.test(line)) continue;
      findings.push({
        file: filePath,
        line: i + 1,
        content: line.trim().slice(0, 120),
        patternId: p.id,
        description: p.description,
      });
    }
  }
  return findings;
}

// ── Resolve file list ─────────────────────────────────────────────────────────

let files;

if (args.includes("--all")) {
  files = getAllTrackedFiles();
} else if (args.includes("--diff")) {
  const ref = args[args.indexOf("--diff") + 1] ?? "HEAD~1";
  files = getChangedFiles(ref);
} else if (args.length > 0 && !args[0].startsWith("--")) {
  files = args;
} else {
  // Default: staged files only (pre-commit mode)
  files = getStagedFiles();
  if (files.length === 0) {
    console.log("scan-secrets: no staged files to scan. OK.");
    process.exit(0);
  }
}

const filesToScan = files.filter((f) => !shouldSkip(f));

// ── Scan ──────────────────────────────────────────────────────────────────────

const allFindings = [];
for (const f of filesToScan) {
  allFindings.push(...scanFile(f));
}

// ── Report ────────────────────────────────────────────────────────────────────

const scannedCount = filesToScan.length;

if (allFindings.length === 0) {
  console.log(
    `scan-secrets: scanned ${scannedCount} file(s) — no secret patterns found. ✓`,
  );
  process.exit(0);
}

console.error(`\n⚠  scan-secrets: ${allFindings.length} potential secret(s) found in ${scannedCount} file(s) scanned\n`);
for (const f of allFindings) {
  console.error(`  ${f.file}:${f.line}  [${f.patternId}]  ${f.description}`);
  console.error(`    ${f.content}`);
  console.error("");
}
console.error(
  "If this is a false positive, add  // scan-secrets-ignore  on the flagged line.\n" +
    "Never commit real secrets — rotate any credential that was accidentally staged.\n",
);
process.exit(1);
