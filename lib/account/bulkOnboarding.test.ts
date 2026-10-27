import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildErrorReport,
  executeBulkImport,
  neutralizeCsvCell,
  validateBulkCsv,
} from "./bulkOnboarding";

const HEADER = "full_name,phone,date_of_birth,blood_group,genotype";

describe("bulk onboarding CSV (issue #768)", () => {
  it("rejects a malformed 10k-row file quickly with row/column errors", () => {
    const lines = [HEADER];
    for (let i = 0; i < 10_000; i++)
      lines.push(`Name ${i},12,1990-13-01,Z+,AA`);
    const start = performance.now();
    const result = validateBulkCsv(lines.join("\n"), "prog");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]).toEqual({
      row: 2,
      column: "phone",
      message: "INVALID_PHONE",
    });
    expect(result.errors.filter((e) => e.row === 10_001)).toHaveLength(3);
  });

  it("creates pending invites and no duplicates on re-run", async () => {
    const csv = `${HEADER}\nAda Obi,0803 123 4567,1990-01-01,O+,AA\n`;
    const { rows } = validateBulkCsv(csv, "prog");
    expect(rows[0].status).toBe("pending_claim");
    const processed = new Set<string>();
    const create = vi.fn(async () => {});
    await executeBulkImport(rows, processed, create);
    const second = await executeBulkImport(
      validateBulkCsv(csv, "prog").rows,
      processed,
      create,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ created: 0, skipped: 1 });
  });

  it("neutralizes CSV injection in input and report output", () => {
    const { errors } = validateBulkCsv(
      `${HEADER}\n=HYPERLINK("x"),08031234567,1990-01-01,,\n`,
      "prog",
    );
    expect(errors[0].column).toBe("full_name");
    expect(neutralizeCsvCell("=1+1")).toBe("'=1+1");
    expect(
      buildErrorReport([{ row: 2, column: "@x", message: "-y" }]),
    ).toContain(`"'@x","'-y"`);
  });
});
