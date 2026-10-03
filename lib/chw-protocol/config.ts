import "server-only";

import { z } from "zod";

import { ProtocolError } from "./types";

const deploymentValues = [
  "development",
  "test",
  "ci",
  "preview",
  "staging",
  "pilot",
  "production",
  "mainnet",
] as const;
const modeValues = ["mock", "live"] as const;

// Zod's default enum error omits the offending value; a fail-fast schema
// error must name it so a misconfigured deployment is diagnosable from logs.
const deploymentSchema = z.enum(deploymentValues, {
  error: (issue) =>
    `Invalid LAFIYA_DEPLOYMENT_ENV value: ${JSON.stringify(issue.input)}. Expected one of ${deploymentValues.join(", ")}.`,
});
const modeSchema = z.enum(modeValues, {
  error: (issue) =>
    `Invalid ATTESTATION_MODE value: ${JSON.stringify(issue.input)}. Expected one of ${modeValues.join(", ")}.`,
});

export type ProtocolRuntimeConfig = {
  deployment: z.infer<typeof deploymentSchema>;
  attestationMode: z.infer<typeof modeSchema>;
  intentSigningKey: string | undefined;
  epochId: string | undefined;
};

/**
 * A versioned incentive rate card. Per-verification payout amounts are pinned
 * to the card effective at the attestation ledger/time so a later config
 * change can never re-price historical obligations.
 */
export type IncentiveRateCard = {
  id: string;
  version: number;
  amountStroops: bigint;
  asset: string;
  effectiveFrom: Date;
  createdBy: string;
  approvedBy: string;
};

/**
 * Two-person rule: a rate card may only be activated once a second, distinct
 * approver signs off. Self-approval by the proposer is rejected.
 */
export function assertRateCardApproved(card: IncentiveRateCard): void {
  if (!card.approvedBy || card.approvedBy === card.createdBy) {
    throw new ProtocolError(
      "UNSUPPORTED_EPOCH",
      "RATE_CARD_REQUIRES_DISTINCT_APPROVER",
    );
  }
}

/**
 * Resolve the single rate card effective for an asset at a given ledger/time.
 * Exactly one active card must exist per asset at any instant; overlapping
 * effective windows are a governance error and fail closed.
 */
export function resolveRateCard(
  cards: readonly IncentiveRateCard[],
  asset: string,
  at: Date,
): IncentiveRateCard {
  const active = cards.filter(
    (card) => card.asset === asset && card.effectiveFrom.getTime() <= at.getTime(),
  );
  if (active.length === 0) {
    throw new ProtocolError("UNSUPPORTED_EPOCH", "NO_ACTIVE_RATE_CARD");
  }
  const latest = active.reduce((a, b) =>
    a.effectiveFrom.getTime() >= b.effectiveFrom.getTime() ? a : b,
  );
  const overlapping = active.filter(
    (card) =>
      card.id !== latest.id &&
      card.effectiveFrom.getTime() === latest.effectiveFrom.getTime(),
  );
  if (overlapping.length > 0) {
    throw new ProtocolError("UNSUPPORTED_EPOCH", "AMBIGUOUS_ACTIVE_RATE_CARD");
  }
  return latest;
}

function inferredDeployment(
  env: NodeJS.ProcessEnv,
): z.infer<typeof deploymentSchema> {
  if (env.LAFIYA_DEPLOYMENT_ENV)
    return deploymentSchema.parse(env.LAFIYA_DEPLOYMENT_ENV);
  if (env.VERCEL_ENV === "production" || env.NODE_ENV === "production")
    return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}

/**
 * The deployment identity is an explicit safety boundary. `NODE_ENV` alone
 * cannot distinguish a real deployment from CI, so CI must identify itself as
 * `ci`; an unlabelled production process fails before it serves a lookup.
 */
export function getProtocolRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProtocolRuntimeConfig {
  const deployment = inferredDeployment(env);
  const attestationMode = modeSchema.parse(
    env.ATTESTATION_MODE ??
      (env.ATTESTATION_CONTRACT_ID || deployment === "production"
        ? "live"
        : "mock"),
  );
  const intentSigningKey = env.CHW_PROTOCOL_INTENT_SIGNING_KEY;
  const epochId = env.CHW_PROTOCOL_EPOCH_ID;

  const isProduction = deployment === "production" || deployment === "mainnet";

  if (isProduction && attestationMode !== "live") {
    throw new ProtocolError("UNSUPPORTED_EPOCH", "PRODUCTION_MOCK_FORBIDDEN");
  }
  if (isProduction && (!intentSigningKey || !epochId)) {
    throw new ProtocolError(
      "UNSUPPORTED_EPOCH",
      "PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE",
    );
  }
  if (isProduction && attestationMode === "live" && !intentSigningKey) {
    throw new ProtocolError("UNSUPPORTED_EPOCH", "INTENT_SIGNING_KEY_REQUIRED");
  }
  return { deployment, attestationMode, intentSigningKey, epochId };
}
