#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/scan-secrets.mjs
//
// Lightweight secret-pattern scanner. Scans staged/changed files (or a
// specified list) for common secret patterns — API keys, private keys, and
// Supabase/Stellar credential formats — and flags matches clearly.
//
// This is a belt-and-suspenders complement to GitHub's own secret scanning,
// designed to catch accidental credential commits BEFORE they ever reach the
// remote repository. It runs:
//   • as a pre-commit hook (see .githooks/pre-commit)
//   • as a CI step (`npm run secrets:scan`)
//
// Usage:
//   # Scan staged files (pre-commit mode, default):
//   node scripts/scan-secrets.mjs
//   node scripts/scan-secrets.mjs --staged
//
//   # Scan all tracked files in HEAD (CI mode):
//   node scripts/scan-secrets.mjs --all
//
//   # Scan specific files:
//   node scripts/scan-secrets.mjs --files lib/env.ts scripts/foo.mjs
//
// Exit codes:
//   0  — no matches found (clean)
//   1  — one or more secret patterns matched
// ---------------------------------------------------------------------------

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

// ── Pattern definitions ──────────────────────────────────────────────────────
// Each entry: { name, pattern, description }
// Patterns are tested line-by-line; match → flag.
//
// Design principle: prefer high-specificity patterns over broad ones to keep
// the false-positive rate low against legitimate production code.
const SECRET_PATTERNS = [
  // Generic high-entropy API keys (≥20 chars of [A-Za-z0-9_\-])
  {
    name: "generic-api-key",
    pattern: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9_\-]{20,})["']?/i,
    description: "Generic API key or secret assignment",
  },
  // Private key headers (PEM format)
  {
    name: "private-key-pem",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    description: "PEM private key block",
  },
  // Supabase service role key (JWT starting with eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 + role: service_role)
  // Real service role JWTs contain "service_role" in the payload.
  // We match the well-known demo key prefix + production-length tokens to
  // avoid flagging the short demo keys committed intentionally in .env.test.
  {
    name: "supabase-service-role-key",
    pattern: /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["']?(?!.*dummy|.*demo|.*for-build-only)([A-Za-z0-9_\-\.]{80,})["']?/i,
    description: "Supabase service role key (production-length JWT)",
  },
  // Stellar secret keys: base32 encoded, always start with 'S', 56 chars
  {
    name: "stellar-secret-key",
    pattern: /\bS[A-Z2-7]{55}\b/,
    description: "Stellar account secret key (starts with S, 56 chars base32)",
  },
  // Generic bearer / auth tokens in source code (not env files)
  {
    name: "bearer-token-hardcoded",
    pattern: /Authorization\s*[:=]\s*["']?Bearer\s+([A-Za-z0-9_\-\.]{20,})["']?/i,
    description: "Hardcoded Bearer token in source",
  },
  // AWS access key IDs
  {
    name: "aws-access-key-id",
    pattern: /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/,
    description: "AWS access key ID",
  },
  // AWS secret access keys
  {
    name: "aws-secret-key",
    pattern: /(?:aws[_-]?secret[_-]?(?:access[_-]?)?key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?([A-Za-z0-9\/\+]{40})["']?/i,
    description: "AWS secret access key",
  },
  // GitHub personal access tokens (classic: ghp_, fine-grained: github_pat_)
  {
    name: "github-token",
    pattern: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/,
    description: "GitHub personal access token",
  },
  // Sentry DSN with embedded secret (old format: https://key:secret@...)
  {
    name: "sentry-dsn-with-secret",
    pattern: /https:\/\/[a-f0-9]{32}:[a-f0-9]{32}@\w+\.ingest\.sentry\.io/i,
    description: "Sentry DSN containing embedded secret",
  },
  // Stripe secret keys
  {
    name: "stripe-secret-key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/,
    description: "Stripe secret key",
  },
  // Vercel tokens
  {
    name: "vercel-token",
    pattern: /\bvercel[_-]?(?:token|secret)\s*[:=]\s*["']?([A-Za-z0-9]{24,})["']?/i,
    description: "Vercel token or secret",
  },
];

// ── Files / extensions to always skip ────────────────────────────────────────
// These either contain intentional dummy values, are binary, or are
// auto-generated files that should never be scanned.
const SKIP_PATHS = new Set([
  ".env.test",          // committed intentionally with demo Supabase keys
  ".env.example",       // template with placeholder values
  "package-lock.json",  // auto-generated
  "scripts/scan-secrets.mjs", // this file itself (contains the patterns as literals)
  // CI workflow files contain the well-known public Supabase demo JWTs
  // (iss: supabase-demo, exp: 1983812996) needed for `supabase start` in CI.
  // These are intentionally committed and are not production credentials.
  ".github/workflows/ci.yml",
  ".github/workflows/loadtest-get-emergency-card.yml",
]);

const SKIP_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz",
  ".lock",  // lockfiles
]);

// Lines containing these strings are considered test/fixture/example values
// and are skipped even if they match a pattern.
const ALLOWLIST_LINE_HINTS = [
  "dummy",
  "placeholder",
  "example",
  "replace-me",
  "your-key-here",
  "for-build-only",
  "TODO",
  "FIXME",
  "fake",
  "test-only",
  "demo",
];

// ── Argument parsing ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const modeAll = args.includes("--all");
const modeStaged = args.includes("--staged") || (!modeAll && !args.includes("--files"));
const filesIdx = args.indexOf("--files");
const explicitFiles = filesIdx !== -1 ? args.slice(filesIdx + 1) : [];

// ── File discovery ────────────────────────────────────────────────────────────
function getStagedFiles() {
  try {
    const out = execSync("git diff --cached --name-only --diff-filter=ACM", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function getAllTrackedFiles() {
  try {
    const out = execSync("git ls-files", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

let filesToScan = [];
if (explicitFiles.length > 0) {
  filesToScan = explicitFiles;
} else if (modeAll) {
  filesToScan = getAllTrackedFiles();
} else {
  filesToScan = getStagedFiles();
}

// ── Scan ──────────────────────────────────────────────────────────────────────
const findings = []; // { file, line, lineNumber, patternName, description }

for (const filePath of filesToScan) {
  const relPath = filePath.replace(/^\.\//, "");

  // Skip by path
  if (SKIP_PATHS.has(relPath)) continue;

  // Skip by extension
  const ext = extname(relPath).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) continue;

  // Skip if file doesn't exist (deleted in this diff)
  if (!existsSync(relPath)) continue;

  let content;
  try {
    content = readFileSync(relPath, "utf8");
  } catch {
    // Binary or unreadable file — skip
    continue;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip comment lines that are clearly documentation examples
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) {
      // Still scan, but apply allowlist hints more aggressively for comments
      if (ALLOWLIST_LINE_HINTS.some((hint) => line.toLowerCase().includes(hint.toLowerCase()))) {
        continue;
      }
    }

    // Skip allowlisted lines
    if (ALLOWLIST_LINE_HINTS.some((hint) => line.toLowerCase().includes(hint.toLowerCase()))) {
      continue;
    }

    for (const { name, pattern, description } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          file: relPath,
          line: line.trim().slice(0, 120), // truncate long lines
          lineNumber: i + 1,
          patternName: name,
          description,
        });
        break; // one finding per line is enough
      }
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
const mode = explicitFiles.length > 0 ? "explicit files" : modeAll ? "--all tracked files" : "--staged files";
console.log(`Secret scan: ${filesToScan.length} file(s) scanned (${mode})`);

if (findings.length === 0) {
  console.log("✓ No secret patterns found.");
  process.exit(0);
}

console.error(`\nERROR: ${findings.length} potential secret(s) found:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.lineNumber}  [${f.patternName}]`);
  console.error(`  ${f.description}`);
  console.error(`  > ${f.line}`);
  console.error();
}
console.error("If these are intentional test fixtures or dummy values, add a hint word");
console.error("like 'dummy', 'example', 'placeholder', or 'fake' on the same line to suppress.");
console.error("If these are real credentials, remove them from the file before committing.");
process.exit(1);
