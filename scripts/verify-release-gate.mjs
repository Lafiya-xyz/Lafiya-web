import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

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

console.log(
  "Mainnet release gate evidence is complete for this immutable build.",
);
