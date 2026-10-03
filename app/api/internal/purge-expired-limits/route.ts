import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env-server";
import { logInfo, logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issue #514: fallback trigger for purge_expired_limits() (see
 * supabase/migrations/20260929210000_rate_and_frequency_limits_gc.sql) for
 * any environment where the pg_cron extension isn't available -- point an
 * external scheduler (e.g. a platform cron, GitHub Actions schedule) at this
 * route every 5 minutes with the same bearer-secret pattern already used by
 * POST /api/internal/payout-indexer.
 *
 * Loops until a call reports (0, 0) purged (bounded to avoid ever running
 * unbounded inside a single request) so a large backlog drains over a few
 * calls of this route rather than needing the operator to notice and
 * re-trigger it manually.
 */
const MAX_ITERATIONS_PER_REQUEST = 10;
const BATCH_SIZE = 1000;

export async function POST(request: Request) {
  const cronSecret = serverEnv.PURGE_LIMITS_CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "Purge cron secret is not configured" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  let totalRateLimitsPurged = 0;
  let totalFrequencyLimitsPurged = 0;

  for (let iteration = 0; iteration < MAX_ITERATIONS_PER_REQUEST; iteration++) {
    const { data, error } = await supabase
      .rpc("purge_expired_limits", { p_batch_size: BATCH_SIZE })
      .single();

    if (error) {
      logError("purge_expired_limits_failed", { message: error.message });
      return NextResponse.json({ error: "Purge failed" }, { status: 500 });
    }

    totalRateLimitsPurged += data.rate_limits_purged;
    totalFrequencyLimitsPurged += data.frequency_limits_purged;

    if (data.rate_limits_purged === 0 && data.frequency_limits_purged === 0) {
      break;
    }
  }

  logInfo("purge_expired_limits_completed", {
    rateLimitsPurged: totalRateLimitsPurged,
    frequencyLimitsPurged: totalFrequencyLimitsPurged,
  });

  return NextResponse.json({
    rateLimitsPurged: totalRateLimitsPurged,
    frequencyLimitsPurged: totalFrequencyLimitsPurged,
  });
}
