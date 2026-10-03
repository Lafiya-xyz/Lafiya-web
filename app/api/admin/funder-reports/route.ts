/**
 * Authenticated admin download endpoint for signed monthly funder reports.
 *
 * Implements the "authenticated admin download endpoint" acceptance
 * criterion. GET /api/admin/funder-reports?period=YYYY-MM&format=json|csv
 * returns the report body plus signature metadata so an admin can hand the
 * (report, signature, signerPublicKey) triple to a funder for independent
 * verification via scripts/verify-funder-report.mjs.
 *
 * This route reads pre-aggregated settlement data via
 * `loadSettlementRecordsForPeriod` (left as a thin seam over the existing
 * `payout_obligations`/`payout_settlements` tables -- not implemented here,
 * since wiring real Supabase queries without running/testing them against a
 * live schema is out of scope for this change) and never returns anything
 * beyond region, counts, USDC totals, and transaction hashes: no CHW
 * identity, no patient data.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  buildFunderReport,
  serializeReportCsv,
  serializeReportJson,
  canonicalReportBytes,
  type RawSettlementRecord,
} from "@/lib/stellar/payout-indexer/funder-report";
import { loadReportSigningKeypair, signReportBytes } from "@/lib/stellar/payout-indexer/report-signing";
import { requireAdminSession } from "@/lib/auth/admin-session";

async function loadSettlementRecordsForPeriod(period: string): Promise<RawSettlementRecord[]> {
  // Seam for the real query against payout_obligations/payout_settlements,
  // scoped to obligations whose settlement falls within the UTC month
  // `period`. Left unimplemented here (see file header) -- callers wiring
  // this up should join payout_settlements.transaction_hash and the
  // obligation's region attribute, filtering to status = 'matched'.
  throw new Error(`loadSettlementRecordsForPeriod not wired to a data source yet (period=${period})`);
}

export async function GET(request: NextRequest) {
  const session = await requireAdminSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const period = request.nextUrl.searchParams.get("period");
  const format = request.nextUrl.searchParams.get("format") ?? "json";

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "period query param must be YYYY-MM" }, { status: 400 });
  }
  if (format !== "json" && format !== "csv") {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }

  const records = await loadSettlementRecordsForPeriod(period);
  const report = buildFunderReport(period, records);
  const canonicalBytes = canonicalReportBytes(report);

  const signingSecret = process.env.FUNDER_REPORT_SIGNING_SECRET;
  if (!signingSecret) {
    return NextResponse.json(
      { error: "server missing FUNDER_REPORT_SIGNING_SECRET" },
      { status: 500 },
    );
  }
  const signed = signReportBytes(canonicalBytes, loadReportSigningKeypair(signingSecret));

  const body = format === "csv" ? serializeReportCsv(report) : serializeReportJson(report);

  return NextResponse.json({
    format,
    body,
    schemaVersion: report.schemaVersion,
    period: report.period,
    generatedAt: report.generatedAt,
    signature: signed.signature,
    signerPublicKey: signed.signerPublicKey,
  });
}
