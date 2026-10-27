/**
 * Issue #808: read-only admin audit explorer.
 *
 * GET /api/admin/audit?from=&to=&justification=&actor=&action=
 *     &correlationId=&subject=&page=&pageSize=&format=json|csv
 *
 * Bounded by time range (<= 31 days) and page size (<= 200), filters on
 * indexed columns, applies role-based redaction, and records every query
 * with its justification before returning results. With `format`, the
 * redacted page is returned as a signed export (same signing key and
 * verification flow as funder reports).
 */

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  parseAuditQuery,
  redactEvent,
  serializeAuditCsv,
  serializeAuditJson,
  type AuditEvent,
} from "@/lib/audit/explorer";
import { requireAdminSession } from "@/lib/auth/admin-session";
import { loadReportSigningKeypair, signReportBytes } from "@/lib/stellar/payout-indexer/report-signing";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: NextRequest) {
  const session = await requireAdminSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const parsed = parseAuditQuery(params);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const format = params.get("format");
  if (format !== null && format !== "json" && format !== "csv") {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }

  const signingSecret = process.env.FUNDER_REPORT_SIGNING_SECRET;
  if (format && !signingSecret) {
    return NextResponse.json({ error: "server missing FUNDER_REPORT_SIGNING_SECRET" }, { status: 500 });
  }

  const { filters, justification } = parsed;
  // audit_events / audit_explorer_queries are not in the generated types yet.
  const db = createAdminClient({ purpose: "audit-explorer" }) as unknown as SupabaseClient;

  let query = db
    .from("audit_events")
    .select("*")
    .gte("occurred_at", filters.from.toISOString())
    .lt("occurred_at", filters.to.toISOString())
    .order("occurred_at", { ascending: false })
    .range(filters.page * filters.pageSize, (filters.page + 1) * filters.pageSize - 1);
  if (filters.actor) query = query.eq("actor", filters.actor);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.correlationId) query = query.eq("correlation_id", filters.correlationId);
  if (filters.subjectUserId) query = query.eq("subject_user_id", filters.subjectUserId);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: "audit query failed" }, { status: 500 });
  }
  const events = ((data ?? []) as AuditEvent[]).map((e) => redactEvent(e, session.role));

  // Purpose-limited access: no results leave the server unless the query
  // and its justification were recorded first.
  const { error: auditError } = await db.from("audit_explorer_queries").insert({
    admin_id: session.adminId,
    admin_role: session.role,
    justification,
    filters: { ...filters, from: filters.from.toISOString(), to: filters.to.toISOString() },
    result_count: events.length,
    exported_format: format,
  });
  if (auditError) {
    return NextResponse.json({ error: "could not record audit query" }, { status: 500 });
  }

  if (!format) {
    return NextResponse.json({ events, page: filters.page, pageSize: filters.pageSize });
  }

  const body = format === "csv" ? serializeAuditCsv(events) : serializeAuditJson(events);
  const signed = signReportBytes(Buffer.from(body, "utf8"), loadReportSigningKeypair(signingSecret!));
  return NextResponse.json({
    format,
    body,
    signature: signed.signature,
    signerPublicKey: signed.signerPublicKey,
  });
}
