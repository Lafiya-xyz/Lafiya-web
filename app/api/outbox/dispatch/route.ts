/**
 * POST /api/outbox/dispatch
 *
 * Trigger a single outbox dispatch cycle.  This endpoint is intended to be
 * called by a Supabase cron job, a GitHub Actions schedule, or a simple
 * polling script — NOT from the browser.
 *
 * Authentication: requires the `CRON_SECRET` header to match the
 * `OUTBOX_DISPATCH_SECRET` environment variable so the endpoint cannot be
 * triggered by arbitrary callers.
 *
 * Returns: { dispatched: number, lagMs: number | null, pendingCount: number }
 */

import { NextResponse } from "next/server";
import { runDispatchCycle, getOutboxLag } from "@/lib/outbox/dispatcher";
import { logError } from "@/lib/logging/logger";

export const runtime = "nodejs";
// Disable static caching — this is a mutating internal API.
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.OUTBOX_DISPATCH_SECRET;
  if (!secret) {
    // Misconfiguration: fail closed rather than open.
    return NextResponse.json(
      { error: "Dispatch endpoint not configured." },
      { status: 503 },
    );
  }

  const provided = request.headers.get("x-cron-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const dispatched = await runDispatchCycle();
    const lag = await getOutboxLag();
    return NextResponse.json({ dispatched, ...lag });
  } catch (err) {
    logError("outbox dispatch route: unhandled error", err);
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}
