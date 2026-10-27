import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findingsFromNpmAudit, gateFindings, validateVex } from "./vex.mjs";

const baseDoc = {
  "@context": "https://openvex.dev/ns/v0.2.0",
  "@id": "https://example.test/vex",
  author: "test",
  timestamp: "2026-10-01T00:00:00Z",
  version: 1,
  statements: [] as unknown[],
};
const product = [{ "@id": "pkg:npm/lafiya-web" }];
const audit = (severity: string, id = "GHSA-aaaa-bbbb-cccc") => ({
  vulnerabilities: {
    dep: {
      via: [
        {
          source: 1,
          name: "dep",
          severity,
          title: "t",
          url: `https://github.com/advisories/${id}`,
        },
      ],
    },
  },
});

describe("validateVex", () => {
  it("accepts the committed repository VEX document", () => {
    const doc = JSON.parse(readFileSync("security/vex.openvex.json", "utf8"));
    expect(validateVex(doc)).toEqual([]);
  });

  it("requires a justification enum and reviewer on not_affected", () => {
    const errors = validateVex({
      ...baseDoc,
      statements: [
        {
          vulnerability: { name: "GHSA-aaaa-bbbb-cccc" },
          products: product,
          status: "not_affected",
          justification: "because",
          timestamp: "2026-10-01T00:00:00Z",
        },
      ],
    });
    expect(errors.some((e) => e.includes("justification"))).toBe(true);
    expect(errors.some((e) => e.includes("reviewer"))).toBe(true);
  });

  it("rejects unknown statuses and missing products", () => {
    const errors = validateVex({
      ...baseDoc,
      statements: [
        {
          vulnerability: { name: "X" },
          status: "maybe",
          timestamp: "2026-10-01T00:00:00Z",
        },
      ],
    });
    expect(errors).toHaveLength(2);
  });
});

describe("gateFindings", () => {
  const now = new Date("2026-10-22T00:00:00Z");

  it("fails a critical finding without a VEX entry", () => {
    const { failures } = gateFindings(
      findingsFromNpmAudit(audit("critical")),
      baseDoc,
      now,
    );
    expect(failures).toHaveLength(1);
  });

  it("only warns on an unassessed non-critical finding", () => {
    const result = gateFindings(
      findingsFromNpmAudit(audit("high")),
      baseDoc,
      now,
    );
    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("passes a critical finding assessed as not_affected", () => {
    const vex = {
      ...baseDoc,
      statements: [
        {
          vulnerability: { name: "GHSA-aaaa-bbbb-cccc" },
          products: product,
          status: "not_affected",
          justification: "vulnerable_code_not_in_execute_path",
          reviewer: "security@lafiya",
          timestamp: "2026-10-01T00:00:00Z",
        },
      ],
    };
    expect(
      gateFindings(findingsFromNpmAudit(audit("critical")), vex, now).failures,
    ).toEqual([]);
  });

  it("fails an under_investigation finding past its severity SLA", () => {
    const vex = {
      ...baseDoc,
      statements: [
        {
          vulnerability: { name: "GHSA-aaaa-bbbb-cccc" },
          products: product,
          status: "under_investigation",
          timestamp: "2026-10-01T00:00:00Z",
        },
      ],
    };
    expect(
      gateFindings(findingsFromNpmAudit(audit("high")), vex, now).failures,
    ).toHaveLength(1);
    expect(
      gateFindings(findingsFromNpmAudit(audit("moderate")), vex, now).failures,
    ).toEqual([]);
  });
});
