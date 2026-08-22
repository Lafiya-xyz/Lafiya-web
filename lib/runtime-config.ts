import "server-only";

import { z } from "zod";

const MAINNET_NETWORK_PASSPHRASE =
  "Public Global Stellar Network ; September 2015";

export const CURRENT_SCHEMA_COMPATIBILITY = "20260821170000";

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
const attestationModeSchema = z.enum(["mock", "live"]);
const booleanStringSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const optionalString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.url().optional(),
);

const rawServerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  SOROBAN_RPC_URL: z.url(),
  LAFIYA_DEPLOYMENT_ENV: optionalString,
  ATTESTATION_MODE: attestationModeSchema.optional(),
  ATTESTATION_CONTRACT_ID: optionalString,
  ATTESTATION_CACHE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .optional(),
  CHW_PROTOCOL_EPOCH_ID: optionalString,
  CHW_PROTOCOL_INTENT_SIGNING_KEY: optionalString,
  PAYOUT_INDEXER_ENABLED: booleanStringSchema.default(false),
  STELLAR_HORIZON_URL: optionalUrl,
  STELLAR_USDC_ISSUER: optionalString,
  STELLAR_USDC_ASSET_CODE: optionalString,
  CHW_INCENTIVE_POOL_ADDRESS: optionalString,
  PAYOUT_INDEXER_START_LEDGER: z.coerce.number().int().positive().optional(),
  PAYOUT_INDEXER_START_PAYMENT_CURSOR: optionalString,
  PAYOUT_INDEXER_CRON_SECRET: optionalString,
  SENTRY_ENABLED: booleanStringSchema.default(false),
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
  SENTRY_DSN: optionalUrl,
  LAFIYA_BUILD_REVISION: optionalString,
  LAFIYA_SCHEMA_COMPATIBILITY: optionalString,
});

export type DeploymentEnvironment = z.infer<typeof deploymentSchema>;

export type RuntimeConfig = {
  deployment: DeploymentEnvironment;
  isProduction: boolean;
  buildRevision: string;
  schemaCompatibility: string;
  attestation: {
    mode: z.infer<typeof attestationModeSchema>;
    contractConfigured: boolean;
    protocolConfigured: boolean;
  };
  payoutIndexer: { enabled: boolean };
  sentry: { enabled: boolean };
};

/** An intentionally value-free error suitable for startup logs. */
export class RuntimeConfigError extends Error {
  constructor(readonly code: string) {
    super(`INVALID_RUNTIME_CONFIGURATION:${code}`);
    this.name = "RuntimeConfigError";
  }
}

function inferDeployment(env: NodeJS.ProcessEnv): DeploymentEnvironment {
  if (env.LAFIYA_DEPLOYMENT_ENV) {
    return deploymentSchema.parse(env.LAFIYA_DEPLOYMENT_ENV);
  }
  if (env.NODE_ENV === "test") return "test";
  if (env.VERCEL_ENV === "preview") return "preview";
  // A process that labels itself production must declare its Lafiya identity.
  // NODE_ENV alone cannot distinguish a build job from a patient-facing release.
  if (env.NODE_ENV === "production") {
    throw new RuntimeConfigError("DEPLOYMENT_IDENTITY_REQUIRED");
  }
  return "development";
}

function requireConfigured(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new RuntimeConfigError(code);
}

function isStellarPublicKey(value: string | undefined): boolean {
  return value !== undefined && /^G[A-Z2-7]{55}$/.test(value);
}

function isSorobanContractId(value: string | undefined): boolean {
  return value !== undefined && /^C[A-Z2-7]{55}$/.test(value);
}

/**
 * Parses all server configuration as a single security boundary. Feature
 * groups are explicit: a deployed feature is either complete or the process
 * fails before accepting traffic. The returned shape deliberately excludes
 * every secret, so it is safe to use for readiness output.
 */
export function getRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const parsed = rawServerEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    STELLAR_NETWORK_PASSPHRASE: env.STELLAR_NETWORK_PASSPHRASE,
    SOROBAN_RPC_URL: env.SOROBAN_RPC_URL,
    LAFIYA_DEPLOYMENT_ENV: env.LAFIYA_DEPLOYMENT_ENV,
    ATTESTATION_MODE: env.ATTESTATION_MODE,
    ATTESTATION_CONTRACT_ID: env.ATTESTATION_CONTRACT_ID,
    ATTESTATION_CACHE_TTL_SECONDS: env.ATTESTATION_CACHE_TTL_SECONDS,
    CHW_PROTOCOL_EPOCH_ID: env.CHW_PROTOCOL_EPOCH_ID,
    CHW_PROTOCOL_INTENT_SIGNING_KEY: env.CHW_PROTOCOL_INTENT_SIGNING_KEY,
    PAYOUT_INDEXER_ENABLED: env.PAYOUT_INDEXER_ENABLED,
    STELLAR_HORIZON_URL: env.STELLAR_HORIZON_URL,
    STELLAR_USDC_ISSUER: env.STELLAR_USDC_ISSUER,
    STELLAR_USDC_ASSET_CODE: env.STELLAR_USDC_ASSET_CODE,
    CHW_INCENTIVE_POOL_ADDRESS: env.CHW_INCENTIVE_POOL_ADDRESS,
    PAYOUT_INDEXER_START_LEDGER: env.PAYOUT_INDEXER_START_LEDGER,
    PAYOUT_INDEXER_START_PAYMENT_CURSOR:
      env.PAYOUT_INDEXER_START_PAYMENT_CURSOR,
    PAYOUT_INDEXER_CRON_SECRET: env.PAYOUT_INDEXER_CRON_SECRET,
    SENTRY_ENABLED: env.SENTRY_ENABLED,
    NEXT_PUBLIC_SENTRY_DSN: env.NEXT_PUBLIC_SENTRY_DSN,
    SENTRY_DSN: env.SENTRY_DSN,
    LAFIYA_BUILD_REVISION: env.LAFIYA_BUILD_REVISION,
    LAFIYA_SCHEMA_COMPATIBILITY: env.LAFIYA_SCHEMA_COMPATIBILITY,
  });
  if (!parsed.success) throw new RuntimeConfigError("MALFORMED_VALUE");

  const config = parsed.data;
  const deployment = inferDeployment(env);
  const isProduction = deployment === "production" || deployment === "mainnet";
  const attestationMode =
    config.ATTESTATION_MODE ??
    (config.ATTESTATION_CONTRACT_ID || isProduction ? "live" : "mock");
  const protocolConfigured = Boolean(
    config.CHW_PROTOCOL_EPOCH_ID && config.CHW_PROTOCOL_INTENT_SIGNING_KEY,
  );

  if (isProduction) {
    requireConfigured(attestationMode === "live", "PRODUCTION_MOCK_FORBIDDEN");
    requireConfigured(
      env.LAFIYA_DEPLOYMENT_ENV,
      "DEPLOYMENT_IDENTITY_REQUIRED",
    );
    requireConfigured(config.LAFIYA_BUILD_REVISION, "BUILD_REVISION_REQUIRED");
    requireConfigured(
      config.LAFIYA_SCHEMA_COMPATIBILITY === CURRENT_SCHEMA_COMPATIBILITY,
      "SCHEMA_COMPATIBILITY_MISMATCH",
    );
    requireConfigured(config.SENTRY_ENABLED, "SENTRY_REQUIRED");
  }

  if (isProduction) {
    requireConfigured(
      config.STELLAR_NETWORK_PASSPHRASE === MAINNET_NETWORK_PASSPHRASE,
      "MAINNET_NETWORK_REQUIRED",
    );
  } else {
    requireConfigured(
      config.STELLAR_NETWORK_PASSPHRASE !== MAINNET_NETWORK_PASSPHRASE,
      "MAINNET_NETWORK_OUTSIDE_MAINNET",
    );
  }

  if (attestationMode === "live") {
    requireConfigured(
      isSorobanContractId(config.ATTESTATION_CONTRACT_ID),
      "LIVE_ATTESTATION_CONTRACT_REQUIRED",
    );
  } else {
    requireConfigured(
      !config.ATTESTATION_CONTRACT_ID,
      "MOCK_ATTESTATION_CONTRACT_FORBIDDEN",
    );
  }

  if (isProduction) {
    requireConfigured(
      protocolConfigured,
      "PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE",
    );
  }

  const indexerSettings = [
    config.STELLAR_HORIZON_URL,
    config.STELLAR_USDC_ISSUER,
    config.STELLAR_USDC_ASSET_CODE,
    config.CHW_INCENTIVE_POOL_ADDRESS,
    config.PAYOUT_INDEXER_START_LEDGER,
    config.PAYOUT_INDEXER_START_PAYMENT_CURSOR,
    config.PAYOUT_INDEXER_CRON_SECRET,
  ];
  if (config.PAYOUT_INDEXER_ENABLED) {
    requireConfigured(
      attestationMode === "live",
      "INDEXER_REQUIRES_LIVE_ATTESTATION",
    );
    requireConfigured(
      indexerSettings.every(Boolean),
      "PAYOUT_INDEXER_CONFIG_INCOMPLETE",
    );
    requireConfigured(
      isStellarPublicKey(config.STELLAR_USDC_ISSUER),
      "USDC_ISSUER_INVALID",
    );
    requireConfigured(
      config.STELLAR_USDC_ASSET_CODE === "USDC",
      "USDC_ASSET_INVALID",
    );
    requireConfigured(
      isStellarPublicKey(config.CHW_INCENTIVE_POOL_ADDRESS),
      "INCENTIVE_POOL_INVALID",
    );
    requireConfigured(
      (config.PAYOUT_INDEXER_CRON_SECRET?.length ?? 0) >= 32,
      "CRON_SECRET_TOO_SHORT",
    );
  } else {
    requireConfigured(
      indexerSettings.every((value) => value === undefined),
      "PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION",
    );
  }

  if (config.SENTRY_ENABLED) {
    requireConfigured(
      Boolean(config.NEXT_PUBLIC_SENTRY_DSN || config.SENTRY_DSN),
      "SENTRY_DSN_REQUIRED",
    );
  } else {
    requireConfigured(
      !config.NEXT_PUBLIC_SENTRY_DSN && !config.SENTRY_DSN,
      "SENTRY_DISABLED_WITH_CONFIGURATION",
    );
  }

  return {
    deployment,
    isProduction,
    buildRevision:
      config.LAFIYA_BUILD_REVISION ??
      env.VERCEL_GIT_COMMIT_SHA ??
      env.GITHUB_SHA ??
      "unversioned",
    schemaCompatibility:
      config.LAFIYA_SCHEMA_COMPATIBILITY ?? CURRENT_SCHEMA_COMPATIBILITY,
    attestation: {
      mode: attestationMode,
      contractConfigured: Boolean(config.ATTESTATION_CONTRACT_ID),
      protocolConfigured,
    },
    payoutIndexer: { enabled: config.PAYOUT_INDEXER_ENABLED },
    sentry: { enabled: config.SENTRY_ENABLED },
  };
}

export const serverEnvSchema = rawServerEnvSchema;
