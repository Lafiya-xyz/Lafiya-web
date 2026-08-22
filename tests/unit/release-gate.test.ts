import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const workspaceEvidenceFiles: string[] = [];
let createdWorkspaceEvidenceDirectory = false;

function writeEvidence(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lafiya-release-gate-"));
  directories.push(directory);
  const evidencePath = join(directory, "evidence.json");
  writeFileSync(
    evidencePath,
    JSON.stringify({
      schemaVersion: 1,
      environment: "mainnet",
      buildRevision: "a".repeat(40),
      expiresAt: "2030-01-01T00:00:00.000Z",
      evidence: {
        ciRun: "ci",
        sbomProvenance: "sbom",
        migrationRehearsal: "migration",
        loadAndFaultExercise: "load",
        restoreDrill: "restore",
        rotationExercise: "rotation",
        privacyCanary: "privacy",
        securityReview: "security",
        pilotRehearsal: "pilot",
      },
      approvals: [{ role: "release-owner" }, { role: "independent-approver" }],
      ...overrides,
    }),
  );
  return evidencePath;
}

function run(evidencePath: string) {
  return spawnSync(
    process.execPath,
    ["scripts/verify-release-gate.mjs", evidencePath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GITHUB_SHA: "a".repeat(40) },
    },
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const file of workspaceEvidenceFiles.splice(0)) {
    unlinkSync(file);
  }
  if (createdWorkspaceEvidenceDirectory) {
    try {
      rmdirSync(join(process.cwd(), "release-evidence"));
    } catch {
      // Never remove a directory or evidence created by a test caller.
    }
    createdWorkspaceEvidenceDirectory = false;
  }
});

describe("mainnet release gate", () => {
  it("rejects evidence outside the controlled release-evidence directory", () => {
    const result = run(writeEvidence());

    expect(result.status).toBe(1);
  });

  it("fails closed for malformed approval evidence", () => {
    const evidenceDirectory = join(process.cwd(), "release-evidence");
    if (!existsSync(evidenceDirectory))
      createdWorkspaceEvidenceDirectory = true;
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(evidenceDirectory, "gate-test.json");
    workspaceEvidenceFiles.push(evidencePath);
    writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: 1,
        environment: "mainnet",
        buildRevision: "a".repeat(40),
        expiresAt: "2030-01-01T00:00:00.000Z",
        evidence: {
          ciRun: "ci",
          sbomProvenance: "sbom",
          migrationRehearsal: "migration",
          loadAndFaultExercise: "load",
          restoreDrill: "restore",
          rotationExercise: "rotation",
          privacyCanary: "privacy",
          securityReview: "security",
          pilotRehearsal: "pilot",
        },
        approvals: [null, { role: "release-owner" }],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-release-gate.mjs", "release-evidence/gate-test.json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: "a".repeat(40) },
      },
    );

    expect(result.status).toBe(1);
  });

  it("accepts current, complete evidence from the controlled directory", () => {
    const evidenceDirectory = join(process.cwd(), "release-evidence");
    if (!existsSync(evidenceDirectory))
      createdWorkspaceEvidenceDirectory = true;
    mkdirSync(evidenceDirectory, { recursive: true });
    const evidencePath = join(evidenceDirectory, "gate-test.json");
    workspaceEvidenceFiles.push(evidencePath);
    writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: 1,
        environment: "mainnet",
        buildRevision: "a".repeat(40),
        expiresAt: "2030-01-01T00:00:00.000Z",
        evidence: {
          ciRun: "ci",
          sbomProvenance: "sbom",
          migrationRehearsal: "migration",
          loadAndFaultExercise: "load",
          restoreDrill: "restore",
          rotationExercise: "rotation",
          privacyCanary: "privacy",
          securityReview: "security",
          pilotRehearsal: "pilot",
        },
        approvals: [{ role: "release-owner" }, { role: "security-owner" }],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/verify-release-gate.mjs", "release-evidence/gate-test.json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, GITHUB_SHA: "a".repeat(40) },
      },
    );

    expect(result.status).toBe(0);
  });
});
