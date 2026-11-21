/**
 * Issue #937: partner webhook delivery console.
 * GET  /api/partner/webhooks/deliveries[?endpoint=<id>&limit=50]
 * POST /api/partner/webhooks/deliveries/<id>/replay  (see ./[id]/replay)
 *
 * Scoped to the partner that owns the API key; only redacted snapshots are
 * returned.
 */

import { NextRequest, NextResponse } from "next/server";

import { authenticatePartnerKey } from "@/lib/security/partner-keys";
import { listDeliveries } from "@/lib/webhooks/partner-deliveries";

export async function GET(request: NextRequest) {
  const key = await authenticatePartnerKey(request);
  if (!key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const endpointId = request.nextUrl.searchParams.get("endpoint") ?? undefined;
  const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;
  const deliveries = await listDeliveries({ partnerId: key.partnerId, endpointId, limit });
  return NextResponse.json({ partnerId: key.partnerId, deliveries });
}
