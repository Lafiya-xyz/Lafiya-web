import "server-only";

import { createHash } from "node:crypto";

import { normalizePhone } from "@/lib/account/duplicates";
import { BLOOD_GROUPS, GENOTYPES } from "@/lib/validation/profile";

/**
 * Bulk onboarding from CSV (issue #768).
 *
 * Strict schema validation with a dry-run mode, deterministic idempotency
 * keys so re-running a file creates no duplicates, and CSV-injection
 * neutralization for both input and the result report. Imported rows are
 * created as pending invites: data only becomes active once the individual
 * claims the invite and consents themselves.
 */

export const BULK_COLUMNS = [
  "full_name",
  "phone",
  "date_of_birth",
  "blood_group",
  "genotype",
] as const;
export const MAX_ROWS = 10_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const CHUNK_SIZE = 200;

export type BulkRow = {
  fullName: string;
  phone: string;
  dateOfBirth: string;
  bloodGroup: string | null;
  genotype: string | null;
  idempotencyKey: string;
  status: "pending_claim";
};

export type RowError = { row: number; column: string; message: string };

export type BulkValidationResult = {
  rows: BulkRow[];
  errors: RowError[];
  fileError: string | null;
};

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** Prefix formula-triggering values so spreadsheets treat them as text. */
export function neutralizeCsvCell(value: string): string {
  return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function rowIdempotencyKey(programId: string, phone: string): string {
  return createHash("sha256").update(`${programId}:${phone}`).digest("hex");
}

export function validateBulkCsv(
  text: string,
  programId: string,
): BulkValidationResult {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES)
    return { rows: [], errors: [], fileError: "FILE_TOO_LARGE" };
  const [header, ...data] = parseCsv(text);
  if (
    !header ||
    header.map((h) => h.trim()).join(",") !== BULK_COLUMNS.join(",")
  )
    return { rows: [], errors: [], fileError: "INVALID_HEADER" };
  if (data.length > MAX_ROWS)
    return { rows: [], errors: [], fileError: "TOO_MANY_ROWS" };

  const rows: BulkRow[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  data.forEach((cells, i) => {
    const row = i + 2;
    const err = (column: string, message: string) =>
      errors.push({ row, column, message });
    if (cells.length !== BULK_COLUMNS.length)
      return err("*", "WRONG_COLUMN_COUNT");
    const [fullName, rawPhone, dob, blood, genotype] = cells.map((c) =>
      c.trim(),
    );
    const before = errors.length;
    if (!fullName || fullName.length > 120 || FORMULA_PREFIX.test(fullName))
      err("full_name", "INVALID_NAME");
    const phone = normalizePhone(rawPhone);
    if (!phone) err("phone", "INVALID_PHONE");
    else if (seen.has(phone)) err("phone", "DUPLICATE_IN_FILE");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dob) ||
      Number.isNaN(Date.parse(`${dob}T00:00:00Z`)) ||
      dob > new Date().toISOString().slice(0, 10)
    )
      err("date_of_birth", "INVALID_DATE");
    if (blood && !(BLOOD_GROUPS as readonly string[]).includes(blood))
      err("blood_group", "INVALID_ENUM");
    if (genotype && !(GENOTYPES as readonly string[]).includes(genotype))
      err("genotype", "INVALID_ENUM");
    if (errors.length > before || !phone) return;
    seen.add(phone);
    rows.push({
      fullName,
      phone,
      dateOfBirth: dob,
      bloodGroup: blood || null,
      genotype: genotype || null,
      idempotencyKey: rowIdempotencyKey(programId, phone),
      status: "pending_claim",
    });
  });
  return { rows, errors, fileError: null };
}

export function chunkRows<T>(rows: T[], size = CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size)
    chunks.push(rows.slice(i, i + size));
  return chunks;
}

/**
 * Runs chunks resumably. `alreadyProcessed` holds idempotency keys already
 * committed (e.g. from a previous partial run); those rows are skipped.
 */
export async function executeBulkImport(
  rows: BulkRow[],
  alreadyProcessed: Set<string>,
  createInvite: (row: BulkRow) => Promise<void>,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  for (const chunk of chunkRows(rows)) {
    for (const row of chunk) {
      if (alreadyProcessed.has(row.idempotencyKey)) {
        skipped++;
        continue;
      }
      await createInvite(row);
      alreadyProcessed.add(row.idempotencyKey);
      created++;
    }
  }
  return { created, skipped };
}

/** Result report: row errors only, no secrets or PII beyond row numbers. */
export function buildErrorReport(errors: RowError[]): string {
  const lines = ["row,column,message"];
  for (const e of errors)
    lines.push(
      [String(e.row), e.column, e.message]
        .map((v) => `"${neutralizeCsvCell(v).replace(/"/g, '""')}"`)
        .join(","),
    );
  return lines.join("\n");
}
