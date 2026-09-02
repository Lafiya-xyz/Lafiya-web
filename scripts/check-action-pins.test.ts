import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findMutableReferences,
  findUsesReferences,
  isImmutablePin,
} from "./check-action-pins.mjs";

describe("findUsesReferences", () => {
  it("parses a step-level uses: reference", () => {
    const refs = findUsesReferences(
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n",
    );
    expect(refs).toEqual([
      { action: "actions/checkout", revision: "3d3c42e5aac5ba805825da76410c181273ba90b1" },
    ]);
  });

  it("parses a job-level uses: reference (reusable workflow call, no leading dash)", () => {
    const refs = findUsesReferences(
      "  my-job:\n    uses: octo/repo/.github/workflows/reusable.yml@abcdef0123456789abcdef0123456789abcdef01\n",
    );
    expect(refs).toEqual([
      {
        action: "octo/repo/.github/workflows/reusable.yml",
        revision: "abcdef0123456789abcdef0123456789abcdef01",
      },
    ]);
  });

  it("ignores lines that aren't uses: references", () => {
    const refs = findUsesReferences("      run: npm ci\n      name: Install\n");
    expect(refs).toEqual([]);
  });
});

describe("isImmutablePin", () => {
  it("accepts a 40-character commit SHA for a normal action", () => {
    expect(isImmutablePin("actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1")).toBe(true);
  });

  it("rejects a mutable tag for a normal action", () => {
    expect(isImmutablePin("actions/checkout", "v4")).toBe(false);
    expect(isImmutablePin("actions/checkout", "main")).toBe(false);
  });

  it("rejects a short/partial SHA", () => {
    expect(isImmutablePin("actions/checkout", "3d3c42e")).toBe(false);
  });

  it("accepts a sha256: digest for a docker:// reference", () => {
    expect(
      isImmutablePin("docker://alpine", "sha256:" + "a".repeat(64)),
    ).toBe(true);
  });

  it("rejects a mutable tag for a docker:// reference", () => {
    expect(isImmutablePin("docker://alpine", "3.18")).toBe(false);
  });

  it("rejects a git SHA format for a docker:// reference (wrong digest scheme)", () => {
    expect(isImmutablePin("docker://alpine", "3d3c42e5aac5ba805825da76410c181273ba90b1")).toBe(false);
  });
});

describe("findMutableReferences", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-action-pins-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags a mutable tag", () => {
    writeFileSync(
      join(dir, "ci.yml"),
      "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n",
    );
    const mutable = findMutableReferences(dir);
    expect(mutable).toEqual([{ file: "ci.yml", action: "actions/checkout", revision: "v4" }]);
  });

  it("does not flag a pinned SHA", () => {
    writeFileSync(
      join(dir, "ci.yml"),
      "jobs:\n  test:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n",
    );
    expect(findMutableReferences(dir)).toEqual([]);
  });

  it("does not flag a local composite action", () => {
    writeFileSync(
      join(dir, "ci.yml"),
      "jobs:\n  test:\n    steps:\n      - uses: ./.github/actions/my-action\n",
    );
    expect(findMutableReferences(dir)).toEqual([]);
  });

  it("scans every workflow file in the directory, not just the first", () => {
    writeFileSync(join(dir, "a.yml"), "steps:\n  - uses: actions/checkout@v4\n");
    writeFileSync(join(dir, "b.yaml"), "steps:\n  - uses: actions/setup-node@main\n");
    const mutable = findMutableReferences(dir);
    expect(mutable).toHaveLength(2);
    expect(mutable.map((m) => m.file).sort()).toEqual(["a.yml", "b.yaml"]);
  });

  it("ignores non-workflow files in the directory", () => {
    writeFileSync(join(dir, "README.md"), "uses: actions/checkout@v4\n");
    expect(findMutableReferences(dir)).toEqual([]);
  });
});
