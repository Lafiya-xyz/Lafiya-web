import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env-server";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { PayoutIndexer } from "@/lib/stellar/payout-indexer/indexer";
import {
  HorizonPayoutSource,
  SorobanAttestationSource,
} from "@/lib/stellar/payout-indexer/sources";
import { SupabasePayoutIndexerStore } from "@/lib/stellar/payout-indexer/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function configured() {
  if (!getRuntimeConfig().payoutIndexer.enabled) {
    return null;
  }
  const {
    ATTESTATION_CONTRACT_ID,
    CHW_INCENTIVE_POOL_ADDRESS,
    PAYOUT_INDEXER_CRON_SECRET,
    PAYOUT_INDEXER_START_LEDGER,
    SOROBAN_RPC_URL,
    STELLAR_HORIZON_URL,
    STELLAR_NETWORK_PASSPHRASE,
    STELLAR_USDC_ISSUER,
  } = serverEnv;
  if (
    !ATTESTATION_CONTRACT_ID ||
    !CHW_INCENTIVE_POOL_ADDRESS ||
    !PAYOUT_INDEXER_CRON_SECRET ||
    !PAYOUT_INDEXER_START_LEDGER ||
    !STELLAR_HORIZON_URL ||
    !STELLAR_USDC_ISSUER
  ) {
    return null;
  }
  return {
    contractId: ATTESTATION_CONTRACT_ID,
    poolAddress: CHW_INCENTIVE_POOL_ADDRESS,
    cronSecret: PAYOUT_INDEXER_CRON_SECRET,
    startLedger: PAYOUT_INDEXER_START_LEDGER,
    rpcUrl: SOROBAN_RPC_URL,
    horizonUrl: STELLAR_HORIZON_URL,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
    usdcIssuer: STELLAR_USDC_ISSUER,
  };
}

export async function POST(request: Request) {
  const config = configured();
  if (!config) {
    return NextResponse.json(
      { error: "Payout indexer is not configured" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const indexer = new PayoutIndexer(
    new SupabasePayoutIndexerStore(),
    new SorobanAttestationSource(
      config.rpcUrl,
      config.contractId,
      config.networkPassphrase,
    ),
    new HorizonPayoutSource(
      config.horizonUrl,
      config.poolAddress,
      config.usdcIssuer,
    ),
    config.startLedger,
    serverEnv.PAYOUT_INDEXER_START_PAYMENT_CURSOR,
  );
  return NextResponse.json(await indexer.runOnce());
}
