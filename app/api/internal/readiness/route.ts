import { rpc } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env-server";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DependencyStatus = "ok" | "unreachable";

async function checkSupabase(): Promise<DependencyStatus> {
  try {
    const { error } = await createAdminClient()
      .from("profiles")
      .select("user_id", { head: true, count: "exact" })
      .limit(1);
    return error ? "unreachable" : "ok";
  } catch {
    return "unreachable";
  }
}

async function checkStellar(): Promise<DependencyStatus> {
  try {
    await new rpc.Server(serverEnv.SOROBAN_RPC_URL).getHealth();
    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * Non-sensitive deployment readiness for platform probes. This endpoint never
 * returns a connection string, contract/address, key, record identifier, or
 * patient-derived state. It is deliberately distinct from liveness: a
 * process can be alive while a dependency it needs is not safe/able to
 * receive traffic. The per-dependency breakdown lets on-call go straight to
 * the failing system instead of debugging from zero.
 */
export async function GET() {
  const config = getRuntimeConfig();
  const [supabase, stellar] = await Promise.all([
    checkSupabase(),
    checkStellar(),
  ]);

  const ready = supabase === "ok" && stellar === "ok";
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      build: {
        revision: config.buildRevision,
        schemaCompatibility: config.schemaCompatibility,
      },
      environment: config.deployment,
      components: {
        supabase,
        stellar,
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
