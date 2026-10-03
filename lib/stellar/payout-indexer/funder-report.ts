/**
 * Deterministic monthly funder report generation.
 *
 * Implements the "generate monthly funder reports" issue: aggregated
 * verified registrations and payouts per region, each payout tied to its
 * on-chain transaction hash, with byte-for-byte reproducible output for a
 * fixed input dataset. Signing lives in report-signing.ts.
 *
 * Privacy: report rows are aggregated per region and reference only
 * pseudonymous Stellar addresses and on-chain transaction hashes -- no CHW
 * name, contact info, device data, or any patient health record field is
 * read or included. See docs/funder-report-schema.md for the full privacy
 * review notes.
 */

export const FUNDER_REPORT_SCHEMA_VERSION = 1;

export interface RegionPayoutRow {
  region: string;
  /** Count of verified CHW registrations attributed to the region in this period. */
  verifiedRegistrations: number;
  /** Count of settled payouts in this period. */
  payoutsCount: number;
  /** Sum of settled payout amounts, as a fixed-decimal string (7 dp, USDC's native precision). */
  payoutsTotalUsdc: string;
  /** Sorted, de-duplicated on-chain transaction hashes backing payoutsCount. */
  transactionHashes: string[];
}

export interface FunderReport {
  schemaVersion: number;
  /** UTC period, e.g. "2026-09" for a calendar month. */
  period: string;
  generatedAt: string;
  rows: RegionPayoutRow[];
}

export interface RawSettlementRecord {
  region: string;
  chwVerified: boolean;
  payoutAmountUsdc: string;
  transactionHash: string | null;
}

/**
 * Builds a deterministic report from raw per-CHW settlement records for a
 * UTC calendar month. Determinism guarantees:
 *  - rows are sorted by region (ASCII ascending),
 *  - transactionHashes within a row are sorted and de-duplicated,
 *  - amounts are formatted with fixed 7-decimal precision (matches USDC on
 *    Stellar) using string arithmetic, never floating point, so summation
 *    order cannot change the result,
 *  - `generatedAt` is NOT part of the signed byte stream (see
 *    `canonicalReportBytes`) so re-running generation for the same period
 *    and inputs produces an identical signature.
 */
export function buildFunderReport(
  period: string,
  records: RawSettlementRecord[],
  generatedAt: Date = new Date(),
): FunderReport {
  if (!/^\d{4}-\d{2}$/.test(period)) {
    throw new Error(`period must be a UTC "YYYY-MM" string, got: ${period}`);
  }

  const byRegion = new Map<string, RawSettlementRecord[]>();
  for (const record of records) {
    const list = byRegion.get(record.region) ?? [];
    list.push(record);
    byRegion.set(record.region, list);
  }

  const rows: RegionPayoutRow[] = [...byRegion.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([region, regionRecords]) => {
      const verifiedRegistrations = regionRecords.filter((r) => r.chwVerified).length;
      const paid = regionRecords.filter((r) => r.transactionHash !== null);
      const transactionHashes = [...new Set(paid.map((r) => r.transactionHash as string))].sort();

      return {
        region,
        verifiedRegistrations,
        payoutsCount: paid.length,
        payoutsTotalUsdc: sumFixedDecimal(paid.map((r) => r.payoutAmountUsdc)),
        transactionHashes,
      };
    });

  return {
    schemaVersion: FUNDER_REPORT_SCHEMA_VERSION,
    period,
    generatedAt: generatedAt.toISOString(),
    rows,
  };
}

/** Sums decimal strings (7 dp) using integer arithmetic to avoid floating-point drift. */
function sumFixedDecimal(amounts: string[]): string {
  const DECIMALS = 7;
  const scale = 10 ** DECIMALS;
  let totalScaled = 0n;
  for (const amount of amounts) {
    const [whole, frac = ""] = amount.split(".");
    const fracPadded = (frac + "0".repeat(DECIMALS)).slice(0, DECIMALS);
    totalScaled += BigInt(whole) * BigInt(scale) + BigInt(fracPadded || "0");
  }
  const wholePart = totalScaled / BigInt(scale);
  const fracPart = (totalScaled % BigInt(scale)).toString().padStart(DECIMALS, "0");
  return `${wholePart}.${fracPart}`;
}

/** JSON serialization with stable key ordering (used for both output and the signed byte stream). */
export function serializeReportJson(report: FunderReport): string {
  return JSON.stringify(
    {
      schemaVersion: report.schemaVersion,
      period: report.period,
      rows: report.rows.map((row) => ({
        region: row.region,
        verifiedRegistrations: row.verifiedRegistrations,
        payoutsCount: row.payoutsCount,
        payoutsTotalUsdc: row.payoutsTotalUsdc,
        transactionHashes: row.transactionHashes,
      })),
    },
    null,
    2,
  );
}

export function serializeReportCsv(report: FunderReport): string {
  const header = "region,verified_registrations,payouts_count,payouts_total_usdc,transaction_hashes";
  const lines = report.rows.map((row) =>
    [
      row.region,
      row.verifiedRegistrations,
      row.payoutsCount,
      row.payoutsTotalUsdc,
      `"${row.transactionHashes.join(";")}"`,
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

/**
 * Canonical byte stream used for signing -- excludes `generatedAt` so the
 * signature is reproducible for identical (period, rows) regardless of when
 * the report was generated.
 */
export function canonicalReportBytes(report: FunderReport): Buffer {
  return Buffer.from(
    JSON.stringify({ schemaVersion: report.schemaVersion, period: report.period, rows: report.rows }),
    "utf8",
  );
}
