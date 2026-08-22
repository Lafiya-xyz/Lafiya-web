import { NextResponse } from "next/server";

import { getRuntimeConfig } from "@/lib/runtime-config";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReadinessComponent = "ready" | "unavailable";

/**
 * Non-sensitive deployment readiness for platform probes. This endpoint never
 * returns a connection string, contract/address, key, record identifier, or
 * patient-derived state. It is deliberately distinct from liveness: a
 * process can be alive while its database is not safe to receive traffic.
 */
export async function GET() {
  const config = getRuntimeConfig();
  let database: ReadinessComponent = "ready";

  try {
    const { error } = await createAdminClient()
      .from("profiles")
      .select("user_id", { head: true, count: "exact" })
      .limit(1);
    if (error) database = "unavailable";
  } catch {
    database = "unavailable";
  }

  const ready = database === "ready";
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      build: {
        revision: config.buildRevision,
        schemaCompatibility: config.schemaCompatibility,
      },
      environment: config.deployment,
      components: {
        database,
        attestation: config.attestation.mode,
        payoutIndexer: config.payoutIndexer.enabled ? "enabled" : "disabled",
        sentry: config.sentry.enabled ? "enabled" : "disabled",
      },
    },
    {
      status: ready ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  );
}
