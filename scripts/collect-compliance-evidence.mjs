#!/usr/bin/env node
/**
 * collect-compliance-evidence.mjs
 *
 * Collects signed compliance evidence snapshots from CI run results and
 * produces an auditor-ready bundle (index + artifacts) for a chosen period.
 *
 * Usage:
 *   # Collect evidence for today (called from CI)
 *   node scripts/collect-compliance-evidence.mjs collect \
 *     --run-id <github-run-id> \
 *     --run-url <github-run-url> \
 *     --controls CTL-001,CTL-002 \
 *     --outcome pass
 *
 *   # Bundle evidence for a date range into an auditor-ready archive
 *   node scripts/collect-compliance-evidence.mjs bundle \
 *     --from 2026-10-01 \
 *     --to 2026-10-31 \
 *     --output compliance-bundles/2026-10.json
 *
 *   # Verify a bundle's signatures and completeness
 *   node scripts/collect-compliance-evidence.mjs verify \
 *     --bundle compliance-bundles/2026-10.json
 *
 * Evidence is written to compliance-evidence/YYYY-MM-DD/
 * and signed with a SHA-256 manifest of the record contents.
 *
 * Exit codes:
 *   0  Success
 *   1  Error / verification failure
 */

import {
  createHash,
  createHmac,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const EVIDENCE_DIR = join(REPO_ROOT, "compliance-evidence");
const CATALOG_PATH = join(REPO_ROOT, "docs", "compliance", "control-catalog.md");

// ── PHI detection patterns ───────────────────────────────────────────────────
// These patterns are checked against every evidence artifact before saving.
// They are conservative intentionally — false positives are better than PHI leakage.

const PHI_PATTERNS = [
  // Phone numbers (international format with country code)
  /\+?\d{10,15}/,
  // Dates of birth (YYYY-MM-DD with plausible birth year)
  /\b(19[0-9]{2}|200[0-9]|201[0-2])-\d{2}-\d{2}\b/,
  // Nigerian NIN format (11 digits)
  /\b\d{11}\b/,
  // Card/revision UUID patterns tied to patients (allow generic UUID format in run IDs only)
  // Detects any UUID that appears in a health-record-specific context
  /emergency_contact|date_of_birth|blood_group|genotype|allergies|medications|chronic_condition/i,
  // JWT contents (base64url segments)
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  // Capability tokens (hex strings long enough to be secrets)
  /\b[0-9a-f]{64}\b/i,
];

/**
 * Scan an object for PHI patterns.
 * @param {unknown} value
 * @returns {string[]} list of matched patterns
 */
function scanForPhi(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return PHI_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

// ── Signing ──────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 digest of the canonical JSON of a record.
 * @param {object} record
 * @returns {string} hex digest
 */
function signRecord(record) {
  return createHash("sha256")
    .update(JSON.stringify(record, Object.keys(record).sort()))
    .digest("hex");
}

// ── Evidence record ───────────────────────────────────────────────────────────

/**
 * @typedef {object} EvidenceRecord
 * @property {string} controlId
 * @property {string} controlName
 * @property {string} collectedAt   ISO 8601
 * @property {string} runId
 * @property {string} runUrl
 * @property {"pass"|"fail"|"skip"} outcome
 * @property {string} [notes]
 * @property {string} digest        SHA-256 of the record (excluding this field)
 */

/**
 * Create and save a signed evidence record.
 * @param {Omit<EvidenceRecord, "digest" | "collectedAt">} params
 * @returns {EvidenceRecord}
 */
function createEvidenceRecord({
  controlId,
  controlName,
  runId,
  runUrl,
  outcome,
  notes = "",
}) {
  const record = {
    controlId,
    controlName,
    collectedAt: new Date().toISOString(),
    runId,
    runUrl,
    outcome,
    notes,
  };

  // PHI check before saving
  const phiMatches = scanForPhi(record);
  if (phiMatches.length > 0) {
    throw new Error(
      `PHI detected in evidence record for ${controlId}: patterns matched: ${phiMatches.join(", ")}`,
    );
  }

  record.digest = signRecord(
    Object.fromEntries(Object.entries(record).filter(([k]) => k !== "digest")),
  );

  return record;
}

/**
 * Save evidence record to the dated directory.
 * @param {EvidenceRecord} record
 */
function saveEvidenceRecord(record) {
  const date = record.collectedAt.slice(0, 10); // YYYY-MM-DD
  const dir = join(EVIDENCE_DIR, date);
  mkdirSync(dir, { recursive: true });

  const filename = `${record.controlId}-${Date.now()}.json`;
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf8");
  console.log(`  ✓ Saved ${path}`);
  return path;
}

// ── Bundle ────────────────────────────────────────────────────────────────────

/**
 * Collect all evidence records within a date range.
 * @param {string} from ISO date string YYYY-MM-DD
 * @param {string} to   ISO date string YYYY-MM-DD
 * @returns {EvidenceRecord[]}
 */
function collectRecordsInRange(from, to) {
  if (!existsSync(EVIDENCE_DIR)) return [];

  const dateDirs = readdirSync(EVIDENCE_DIR).filter((name) => {
    return name >= from && name <= to;
  });

  const records = [];
  for (const dateDir of dateDirs) {
    const dirPath = join(EVIDENCE_DIR, dateDir);
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const record = JSON.parse(readFileSync(join(dirPath, file), "utf8"));
        records.push(record);
      } catch {
        console.warn(`  ⚠ Could not parse ${join(dirPath, file)}`);
      }
    }
  }

  return records;
}

/**
 * Verify a single evidence record's digest.
 * @param {EvidenceRecord} record
 * @returns {{ valid: boolean, reason?: string }}
 */
function verifyRecord(record) {
  const { digest, ...rest } = record;
  if (!digest) return { valid: false, reason: "missing digest" };
  const expected = signRecord(rest);
  if (expected !== digest) {
    return {
      valid: false,
      reason: `digest mismatch: expected ${expected}, got ${digest}`,
    };
  }
  return { valid: true };
}

// ── Commands ──────────────────────────────────────────────────────────────────

function cmdCollect(args) {
  const runIdFlag = args.indexOf("--run-id");
  const runUrlFlag = args.indexOf("--run-url");
  const controlsFlag = args.indexOf("--controls");
  const outcomeFlag = args.indexOf("--outcome");
  const notesFlag = args.indexOf("--notes");

  const runId = runIdFlag !== -1 ? args[runIdFlag + 1] : process.env.GITHUB_RUN_ID ?? "local";
  const runUrl = runUrlFlag !== -1 ? args[runUrlFlag + 1] : process.env.GITHUB_RUN_URL ?? "";
  const controlIds = controlsFlag !== -1
    ? args[controlsFlag + 1].split(",").map((s) => s.trim())
    : [];
  const outcome = outcomeFlag !== -1 ? args[outcomeFlag + 1] : "pass";
  const notes = notesFlag !== -1 ? args[notesFlag + 1] : "";

  if (controlIds.length === 0) {
    console.error("--controls is required (comma-separated list of control IDs)");
    process.exit(1);
  }

  // Load control names from catalog
  const catalogContent = existsSync(CATALOG_PATH)
    ? readFileSync(CATALOG_PATH, "utf8")
    : "";
  const controlNames = {};
  for (const line of catalogContent.split("\n")) {
    const match = line.match(/\|\s*(CTL-\d+)\s*\|\s*([^|]+)\|/);
    if (match) {
      controlNames[match[1].trim()] = match[2].trim();
    }
  }

  console.log(`Collecting evidence for ${controlIds.length} control(s)…`);
  for (const controlId of controlIds) {
    const record = createEvidenceRecord({
      controlId,
      controlName: controlNames[controlId] ?? controlId,
      runId,
      runUrl,
      outcome,
      notes,
    });
    saveEvidenceRecord(record);
  }
  console.log("Evidence collection complete.");
}

function cmdBundle(args) {
  const fromFlag = args.indexOf("--from");
  const toFlag = args.indexOf("--to");
  const outputFlag = args.indexOf("--output");

  const from = fromFlag !== -1 ? args[fromFlag + 1] : null;
  const to = toFlag !== -1 ? args[toFlag + 1] : null;
  const outputPath = outputFlag !== -1 ? args[outputFlag + 1] : null;

  if (!from || !to) {
    console.error("--from and --to are required (YYYY-MM-DD)");
    process.exit(1);
  }

  console.log(`Building compliance bundle for ${from} → ${to}…`);
  const records = collectRecordsInRange(from, to);
  const bundle = buildBundleFromRecords(records, from, to);

  console.log(`  Records collected:    ${bundle.totalRecords}`);
  console.log(`  Controls covered:     ${bundle.controlsCovered.length}`);
  console.log(`  Missing controls:     ${bundle.missingControls.length}`);
  console.log(`  PHI violations:       ${bundle.phiViolations.length}`);
  console.log(`  Verification failures: ${bundle.verificationFailures.length}`);
  console.log(`  Bundle complete:      ${bundle.complete}`);

  if (bundle.phiViolations.length > 0) {
    console.error("\n🚫 PHI violations detected:");
    for (const v of bundle.phiViolations) {
      console.error(`  ${v.controlId}: ${v.patterns.join(", ")}`);
    }
    console.error("\nDo not distribute this bundle until PHI violations are resolved.");
  }

  if (outputPath) {
    const resolvedOutput = resolve(outputPath);
    mkdirSync(resolve(resolvedOutput, ".."), { recursive: true });
    writeFileSync(resolvedOutput, JSON.stringify(bundle, null, 2) + "\n", "utf8");
    console.log(`\nBundle written to ${resolvedOutput}`);
  } else {
    console.log("\nBundle (stdout):");
    console.log(JSON.stringify(bundle, null, 2));
  }
}

function cmdVerify(args) {
  const bundleFlag = args.indexOf("--bundle");
  const bundlePath = bundleFlag !== -1 ? args[bundleFlag + 1] : null;

  if (!bundlePath) {
    console.error("--bundle <path> is required");
    process.exit(1);
  }

  let bundle;
  try {
    bundle = JSON.parse(readFileSync(resolve(bundlePath), "utf8"));
  } catch (err) {
    console.error(`Cannot read bundle: ${err.message}`);
    process.exit(1);
  }

  console.log(`Verifying compliance bundle (${bundle.period?.from} → ${bundle.period?.to})…`);

  let failures = 0;

  // 1. Verify manifest digest
  const manifestForSigning = {
    schemaVersion: bundle.schemaVersion,
    bundleCreatedAt: bundle.bundleCreatedAt,
    period: bundle.period,
    totalRecords: bundle.totalRecords,
    controlsCovered: bundle.controlsCovered,
    missingControls: bundle.missingControls,
    phiViolations: bundle.phiViolations,
    verificationFailures: bundle.verificationFailures,
    complete: bundle.complete,
  };
  const expectedManifestDigest = createHash("sha256")
    .update(JSON.stringify(manifestForSigning, Object.keys(manifestForSigning).sort()))
    .digest("hex");

  if (bundle.manifestDigest !== expectedManifestDigest) {
    console.error(`  ✗ Manifest digest invalid (expected ${expectedManifestDigest})`);
    failures++;
  } else {
    console.log("  ✓ Manifest digest valid");
  }

  // 2. Verify each record digest
  for (const record of bundle.records ?? []) {
    const result = verifyRecord(record);
    if (!result.valid) {
      console.error(`  ✗ Record ${record.controlId} (${record.collectedAt}): ${result.reason}`);
      failures++;
    }
  }
  console.log(
    `  ✓ ${(bundle.records?.length ?? 0) - failures} of ${bundle.records?.length ?? 0} records have valid digests`,
  );

  // 3. PHI check
  if (bundle.phiViolations?.length > 0) {
    console.error(`  ✗ ${bundle.phiViolations.length} PHI violation(s) in bundle`);
    failures++;
  } else {
    console.log("  ✓ No PHI violations");
  }

  // 4. Completeness
  if (bundle.missingControls?.length > 0) {
    console.warn(`  ⚠ Missing controls: ${bundle.missingControls.join(", ")}`);
  } else {
    console.log("  ✓ All required controls covered");
  }

  if (failures > 0) {
    console.error(`\nBundle verification FAILED (${failures} issue(s)).`);
    process.exit(1);
  }
  console.log("\nBundle verification PASSED.");
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Export internal helpers for testing and programmatic use
export { createEvidenceRecord, verifyRecord, scanForPhi };

/**
 * Build a bundle directly from a set of records (used by tests and the CLI).
 * @param {object[]} records
 * @param {string} from YYYY-MM-DD
 * @param {string} to   YYYY-MM-DD
 * @returns {object}
 */
export function buildBundleFromRecords(records, from, to) {
  const REQUIRED_CONTROLS = [
    "CTL-001", "CTL-002", "CTL-003", "CTL-004", "CTL-005",
    "CTL-006", "CTL-007", "CTL-008", "CTL-009", "CTL-010",
    "CTL-011", "CTL-012", "CTL-013", "CTL-014", "CTL-015",
  ];

  const collectedControlIds = new Set(records.map((r) => r.controlId));
  const missingControls = REQUIRED_CONTROLS.filter(
    (id) => !collectedControlIds.has(id),
  );

  const phiViolations = [];
  for (const record of records) {
    const matches = scanForPhi(record);
    if (matches.length > 0) {
      phiViolations.push({ controlId: record.controlId, patterns: matches });
    }
  }

  const verificationFailures = [];
  for (const record of records) {
    const result = verifyRecord(record);
    if (!result.valid) {
      verificationFailures.push({
        controlId: record.controlId,
        collectedAt: record.collectedAt,
        reason: result.reason,
      });
    }
  }

  const bundle = {
    schemaVersion: 1,
    bundleCreatedAt: new Date().toISOString(),
    period: { from, to },
    totalRecords: records.length,
    controlsCovered: [...collectedControlIds].sort(),
    missingControls,
    phiViolations,
    verificationFailures,
    complete: missingControls.length === 0 && phiViolations.length === 0 && verificationFailures.length === 0,
    records,
  };

  const manifestForSigning = {
    schemaVersion: bundle.schemaVersion,
    bundleCreatedAt: bundle.bundleCreatedAt,
    period: bundle.period,
    totalRecords: bundle.totalRecords,
    controlsCovered: bundle.controlsCovered,
    missingControls: bundle.missingControls,
    phiViolations: bundle.phiViolations,
    verificationFailures: bundle.verificationFailures,
    complete: bundle.complete,
  };
  bundle.manifestDigest = createHash("sha256")
    .update(JSON.stringify(manifestForSigning, Object.keys(manifestForSigning).sort()))
    .digest("hex");

  return bundle;
}

const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "collect":
    cmdCollect(args);
    break;
  case "bundle":
    cmdBundle(args);
    break;
  case "verify":
    cmdVerify(args);
    break;
  default:
    console.error(`
Usage:
  node scripts/collect-compliance-evidence.mjs collect --run-id <id> --run-url <url> --controls <ids> --outcome <pass|fail|skip>
  node scripts/collect-compliance-evidence.mjs bundle  --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--output <path>]
  node scripts/collect-compliance-evidence.mjs verify  --bundle <path>
`);
    process.exit(1);
}
