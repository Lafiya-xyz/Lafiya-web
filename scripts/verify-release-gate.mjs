import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateErrorBudget } from "./error-budget.mjs";

const evidencePath = process.argv[2];
const resolvedEvidencePath = evidencePath && resolve(evidencePath);
const relativeEvidencePath =
  resolvedEvidencePath && relative(process.cwd(), resolvedEvidencePath);
if (
  !evidencePath ||
  !relativeEvidencePath ||
  relativeEvidencePath.startsWith("..") ||
  !relativeEvidencePath.startsWith(`release-evidence${sep}`)
) {
  console.error("Usage: node scripts/verify-release-gate.mjs <evidence.json>");
  process.exit(1);
}

let gate;
try {
  gate = JSON.parse(readFileSync(resolvedEvidencePath, "utf8"));
} catch {
  console.error("Release evidence is missing or is not valid JSON.");
  process.exit(1);
}

const requiredEvidence = [
  "ciRun",
  "sbomProvenance",
  "migrationRehearsal",
  "loadAndFaultExercise",
  "restoreDrill",
  "rotationExercise",
  "privacyCanary",
  "securityReview",
  "pilotRehearsal",
];

const isObject = (value) => typeof value === "object" && value !== null;
const gateObject = isObject(gate) ? gate : {};
const evidence = isObject(gateObject.evidence) ? gateObject.evidence : {};
const approvals = Array.isArray(gateObject.approvals)
  ? gateObject.approvals
  : [];
const approvalRoles = approvals
  .filter(isObject)
  .map((approval) => approval.role)
  .filter((role) => typeof role === "string" && role.trim());

const valid =
  gateObject.schemaVersion === 1 &&
  gateObject.environment === "mainnet" &&
  gateObject.buildRevision === process.env.GITHUB_SHA &&
  typeof gateObject.expiresAt === "string" &&
  Date.parse(gateObject.expiresAt) > Date.now() &&
  requiredEvidence.every(
    (name) => typeof evidence[name] === "string" && evidence[name].trim(),
  ) &&
  approvalRoles.length >= 2 &&
  new Set(approvalRoles).size >= 2;

if (!valid) {
  console.error(
    "Mainnet release gate is incomplete, expired, or for another build.",
  );
  process.exit(1);
}

const provenance = isObject(gateObject.provenance) ? gateObject.provenance : {};
const provenanceArtifacts = [
  { name: "build", digest: provenance.buildDigest },
  { name: "sbom", digest: provenance.sbomDigest },
];

const isDigest = (value) =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);

const verifyAttestation = ({ name, digest }) => {
  if (!isDigest(digest)) {
    console.error(
      `Missing or malformed SLSA provenance digest for the ${name} artefact.`,
    );
    return false;
  }

  const result = spawnSync(
    "gh",
    [
      "attestation",
      "verify",
      `oci://${digest}`,
      "--repo",
      process.env.GITHUB_REPOSITORY ?? "",
      "--signer-workflow",
      `${process.env.GITHUB_REPOSITORY ?? ""}/.github/workflows/mainnet-release.yml`,
      "--source-digest",
      process.env.GITHUB_SHA ?? "",
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    console.error(
      `SLSA provenance verification failed for the ${name} artefact (${digest}).`,
    );
    if (result.stderr) {
      console.error(result.stderr.trim());
    }
    return false;
  }

  return true;
};

const provenanceValid = provenanceArtifacts.every(verifyAttestation);

if (!provenanceValid) {
  console.error(
    "Mainnet release gate rejected: build provenance is missing or mismatched.",
  );
  process.exit(1);
}

// ── Error-budget gate ─────────────────────────────────────────────────────────
// If a metrics file is present at release-evidence/error-budget-metrics.json,
// evaluate the error budget and block if the gate status is "blocked".
// The metrics file is optional; absent metrics are treated as a warning only.

const metricsPath = resolve(process.cwd(), "release-evidence", "error-budget-metrics.json");

if (existsSync(metricsPath)) {
  let metrics;
  try {
    metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
  } catch {
    console.warn("Warning: error-budget-metrics.json is not valid JSON — skipping budget gate.");
    metrics = null;
  }

  if (metrics) {
    const budget = evaluateErrorBudget(metrics);

    console.log(`\nError-budget status:`);
    console.log(`  SLO target:        ${(budget.sloTarget * 100).toFixed(2)}%`);
    console.log(`  Budget total:      ${budget.errorBudgetMinutes.toFixed(2)} minutes`);
    console.log(`  Budget consumed:   ${budget.consumedMinutes.toFixed(2)} minutes (${(budget.consumedFraction * 100).toFixed(1)}%)`);
    console.log(`  Budget remaining:  ${budget.remainingMinutes.toFixed(2)} minutes (${(budget.remainingFraction * 100).toFixed(1)}%)`);
    console.log(`  Gate status:       ${budget.gateStatus.toUpperCase()}`);
    console.log(`  Gate reason:       ${budget.gateReason}`);

    if (budget.alerts.length > 0) {
      console.log(`\nBurn-rate alerts:`);
      for (const alert of budget.alerts) {
        console.log(`  [${alert.severity.toUpperCase()}] ${alert.message}`);
      }
    }

    // Check for explicit override in the gate evidence
    const override = isObject(gateObject.errorBudgetOverride) ? gateObject.errorBudgetOverride : null;
    if (budget.gateStatus === "blocked") {
      if (override && typeof override.reason === "string" && override.reason.trim() && typeof override.actor === "string" && override.actor.trim()) {
        console.warn(
          `\nError-budget gate override applied by '${override.actor}': ${override.reason}`,
        );
        console.warn("Override is recorded in the release evidence — this action is auditable.");
      } else {
        console.error(
          `\nMainnet release gate rejected: error budget is ${budget.gateStatus}. ${budget.gateReason}`,
        );
        console.error(
          "To override, add an 'errorBudgetOverride' object to the release evidence with 'reason' and 'actor' fields.",
        );
        process.exit(1);
      }
    }
  }
} else {
  console.warn(
    "Warning: release-evidence/error-budget-metrics.json not found. " +
    "Error-budget gate skipped. Add metrics for production releases.",
  );
}

console.log(
  "\nMainnet release gate evidence is complete for this immutable build.",
);
