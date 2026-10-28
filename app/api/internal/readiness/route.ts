import { rpc } from "@stellar/stellar-sdk";
import { NextResponse } from "next/server";

import {
  type ExtensionManifestStatus,
  type ExtensionRow,
  extensionManifestStatus,
} from "@/lib/db/extension-manifest";
import { serverEnv } from "@/lib/env-server";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { getContractTrustState } from "@/lib/stellar/verification-indexer/trust-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { getFlagStates } from "@/lib/flags";
import { getScheduledJobHealth } from "@/lib/jobs/schedule-health";
import { smsDeliveryMetrics } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DependencyStatus = "ok" | "unreachable";
type StellarStatus = DependencyStatus | "TESTNET_RESET_DETECTED";

/**
 * Verification-indexer gap state. `GAP_DETECTED` means the checkpoint ledger
 * has fallen behind the Soroban RPC retention window (`oldestLedger`), so
 * events may have been lost and the indexer refuses to advance until a
 * backfill completes. Surfaced here so probes/on-call can see it without
 * exposing ledger numbers or contract identifiers.
 */
type IndexerGapStatus = "ok" | "GAP_DETECTED" | "unknown";

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

/**
 * Issue #811: verifies Postgres major and extension versions against
 * `supabase/extensions.manifest.json`. Only the status is returned, never the
 * installed versions, so the probe does not advertise the database fingerprint.
 */
async function checkExtensions(): Promise<ExtensionManifestStatus> {
  try {
    const { data, error } = await createAdminClient().rpc(
      "installed_extension_versions",
    );
    if (error) return "unknown";
    return extensionManifestStatus(data as ExtensionRow[]);
  } catch {
    return "unknown";
  }
}

/**
 * Detect a Stellar testnet reset. A reset wipes contracts and accounts, so the
 * ledger sequence regresses below our checkpoint, the network passphrase no
 * longer matches, or the configured contract is missing. This logic is
 * explicitly forbidden on mainnet: a mainnet deployment must never be marked
 * as reset, and any mismatch there is treated as unreachable instead.
 */
async function checkStellar(): Promise<StellarStatus> {
  const isMainnet = serverEnv.STELLAR_NETWORK === "mainnet";
  try {
    const server = new rpc.Server(serverEnv.SOROBAN_RPC_URL);
    await server.getHealth();

    const latest = await server.getLatestLedger();
    const checkpoint = serverEnv.STELLAR_LEDGER_CHECKPOINT;
    if (
      !isMainnet &&
      typeof checkpoint === "number" &&
      latest.sequence < checkpoint
    ) {
      return "TESTNET_RESET_DETECTED";
    }

    const contractId = serverEnv.SOROBAN_CONTRACT_ID;
    if (!isMainnet && contractId) {
      const entries = await server.getContractData(
        contractId,
        // A missing contract instance is a reset signal.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import("@stellar/stellar-sdk")).xdr.LedgerKey.contractData(
          new (await import("@stellar/stellar-sdk")).Contract(contractId)
            .getFootprint(),
        ),
      );
      if (!entries) {
        return "TESTNET_RESET_DETECTED";
      }
    }

    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * Reads the most recent unresolved gap incident recorded by the verification
 * indexer. Returns `unknown` when the table is unreachable so readiness never
 * silently reports `ok` for a state it could not verify.
 */
async function checkIndexerGap(): Promise<IndexerGapStatus> {
  try {
    const { data, error } = await createAdminClient()
      .from("indexer_gap_incidents")
      .select("id")
      .is("resolved_at", null)
      .limit(1);
    if (error) return "unknown";
    return data && data.length > 0 ? "GAP_DETECTED" : "ok";
  } catch {
    return "unknown";
  }
}

/**
 * Non-sensitive deployment readiness for platform probes. This endpoint never
 * returns a connection string, contract/address, key, record identifier, or
 * patient-derived state. It is deliberately distinct from liveness: a
 * process can be alive while a dependency it needs is not safe/able to
 * receive traffic. The per-dependency breakdown lets on-call go straight to
 * the failing system instead of debugging from zero.
 *
 * Feature-flag state is reported at the flag level only (enabled/disabled and
 * rollout percentage). Per-user bucketing is never exposed here, so probes
 * cannot be used to infer which cohort a given user falls into.
 */
export async function GET() {
  const config = getRuntimeConfig();
  const [supabase, stellar, attestationGovernance, smsDelivery, scheduledJobs] = await Promise.all([
    checkSupabase(),
    checkStellar(),
    getContractTrustState(),
    // Issue #805: per-network (MTN/Airtel/Glo/9mobile) success rates.
    // Aggregates only — no numbers or message ids. Informational; never
    // fails readiness.
    smsDeliveryMetrics().catch(() => null),
    // Issue #693: per-job "last successful run" age. Informational; a stale
    // job is surfaced to on-call without failing readiness.
    getScheduledJobHealth(),
  ]);
  const flags = await getFlagStates();

  const ready =
    supabase === "ok" &&
    stellar === "ok" &&
    databaseExtensions !== "mismatch" &&
    verificationIndexer !== "GAP_DETECTED";
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
        databaseExtensions,
        verificationIndexer,
        attestation: config.attestation.mode,
        // Issue #629: "needs_review" means an unapproved contract upgrade was
        // observed and verified badges are degraded. Cards remain readable,
        // so this is surfaced to operators without failing readiness.
        attestationGovernance,
        smsDelivery: smsDelivery ?? "unknown",
        scheduledJobs,
        payoutIndexer: config.payoutIndexer.enabled ? "enabled" : "disabled",
        sentry: config.sentry.enabled ? "enabled" : "disabled",
        // Validation results for SOROBAN_RPC_URL / STELLAR_HORIZON_URL --
        // the policy that was enforced and the boot-time DNS check outcome,
        // never the URLs or hosts themselves.
        rpcEndpoints: {
          policy: config.rpcEndpoints.policy,
          resolution: getRpcResolutionStatus(),
        },
      },
      flags,
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
