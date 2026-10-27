/**
 * Issue #809: partner self-service usage. GET /api/partner/usage?period=YYYY-MM
 * with the partner's own API key returns that partner's counters only.
 */

import { NextRequest, NextResponse } from "next/server";

import { authenticatePartnerKey, loadUsage } from "@/lib/security/partner-keys";

export async function GET(request: NextRequest) {
  const key = await authenticatePartnerKey(request);
  if (!key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const period = request.nextUrl.searchParams.get("period") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ error: "period must be YYYY-MM" }, { status: 400 });
  }
  const usage = await loadUsage({ period, partnerId: key.partnerId });
  return NextResponse.json({
    partnerId: key.partnerId,
    period,
    limits: { ratePerMinute: key.ratePerMinute, monthlyQuota: key.monthlyQuota },
    usage,
  });
}
