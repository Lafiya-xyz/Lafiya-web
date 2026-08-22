import "server-only";

import { z } from "zod";

import { ProtocolError } from "./types";

const deploymentSchema = z.enum([
  "development",
  "test",
  "ci",
  "preview",
  "staging",
  "pilot",
  "production",
  "mainnet",
]);
const modeSchema = z.enum(["mock", "live"]);

export type ProtocolRuntimeConfig = {
  deployment: z.infer<typeof deploymentSchema>;
  attestationMode: z.infer<typeof modeSchema>;
  intentSigningKey: string | undefined;
  epochId: string | undefined;
};

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
