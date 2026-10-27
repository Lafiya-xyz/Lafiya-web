/**
 * Issue #809: admin usage report across partners.
 * GET /api/admin/partner-usage?period=YYYY-MM[&partner=<id>]
 */

import { NextRequest, NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin-session";
import { loadUsage } from "@/lib/security/partner-keys";

export async function GET(request: NextRequest) {
  const session = await requireAdminSession(request);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const period = request.nextUrl.searchParams.get("period");
  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "period query param must be YYYY-MM" }, { status: 400 });
  }
  const partnerId = request.nextUrl.searchParams.get("partner") ?? undefined;
  return NextResponse.json({ period, usage: await loadUsage({ period, partnerId }) });
}
