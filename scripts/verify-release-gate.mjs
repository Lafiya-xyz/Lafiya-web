import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

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

console.log(
  "Mainnet release gate evidence is complete for this immutable build.",
);
