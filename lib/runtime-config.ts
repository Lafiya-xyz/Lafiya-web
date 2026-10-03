import "server-only";

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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

/**
 * Supavisor pooler URLs must be transaction-mode endpoints. Session mode
 * pins a server connection for the lifetime of the client, which defeats
 * pooling for serverless callers and breaks under scan bursts. We reject
 * session-mode ports (5432) and require the transaction-mode port (6543)
 * so a misconfigured environment fails fast at startup instead of
 * exhausting Postgres connections in production.
 */
const TRANSACTION_POOLER_PORT = "6543";
const SESSION_POOLER_PORT = "5432";

const optionalPoolerUrl = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z
    .url()
    .refine((value) => {
      const { port } = new URL(value);
      return port !== SESSION_POOLER_PORT;
    }, "must use the transaction-mode pooler port (6543), not session mode (5432)")
    .optional(),
);

const rawServerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: optionalPoolerUrl,
  DIRECT_URL: optionalPoolerUrl,
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
  ATTESTATION_APPROVED_WASM_HASHES: optionalString,
  ACCOUNT_LINKAGE_HMAC_SECRET: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(32).optional(),
  ),
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
  PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: optionalString,
  SENTRY_ENABLED: booleanStringSchema.default(false),
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
  SENTRY_DSN: optionalUrl,
  LAFIYA_BUILD_REVISION: optionalString,
  LAFIYA_SCHEMA_COMPATIBILITY: optionalString,
  // Issue #517: how many reverse-proxy hops between the real client and
  // this process are trusted to have appended (not replaced) an entry to
  // X-Forwarded-For. Only the entry at that distance from the right is
  // ours to trust -- everything to its left is attacker-controlled.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().positive().max(10).default(1),
  // The platform-injected header that is authoritative for the client IP
  // when present (it is set/overwritten by the platform itself, never by
  // the original request), preferred over walking X-Forwarded-For at all.
  // Defaults to Vercel's header since that is this app's deployment target;
  // override for other platforms (e.g. "cf-connecting-ip" on Cloudflare).
  CLIENT_IP_HEADER: optionalString,
  // Issue #514: bearer secret for the POST /api/internal/purge-expired-limits
  // fallback route, used by an external scheduler wherever pg_cron isn't
  // available (see supabase/migrations/20260929210000_rate_and_frequency_limits_gc.sql).
  // Optional -- a deployment whose Postgres does have pg_cron never needs it.
  PURGE_LIMITS_CRON_SECRET: optionalString,
});

export type DeploymentEnvironment = z.infer<typeof deploymentSchema>;

/**
 * Deployments that serve real traffic (or rehearse for it) and therefore only
 * talk to vetted Stellar infrastructure. Everything else -- development, test,
 * ci, preview -- keeps a permissive policy so contributors can point at
 * `http://localhost` or a private RPC.
 */
const ALLOWLISTED_DEPLOYMENTS: ReadonlySet<DeploymentEnvironment> = new Set([
  "staging",
  "pilot",
  "production",
  "mainnet",
]);

const MAINNET_RPC_HOSTS = [
  "mainnet.sorobanrpc.com",
  "soroban-rpc.mainnet.stellar.gateway.fm",
  "stellar-soroban-public.nodies.app",
  "rpc.lightsail.network",
] as const;
const MAINNET_HORIZON_HOSTS = [
  "horizon.stellar.org",
  "horizon.stellar.lobstr.co",
] as const;
const TESTNET_RPC_HOSTS = [
  "soroban-testnet.stellar.org",
  "soroban-rpc.testnet.stellar.gateway.fm",
  "stellar-soroban-testnet-public.nodies.app",
] as const;
const TESTNET_HORIZON_HOSTS = ["horizon-testnet.stellar.org"] as const;

/**
 * Vetted RPC/Horizon hosts per allowlisted deployment (exact hostname match,
 * no wildcards). Keyed by deployment so the list also enforces network
 * consistency: production/mainnet must run on the mainnet passphrase and only
 * mainnet hosts are listed for them; staging/pilot must run off-mainnet and
 * only testnet hosts are listed for them. Providers come from the benchmark
 * in docs/rpc-provider-benchmark.md. Adding a provider is a reviewed code
 * change on purpose -- an environment variable could be changed by the same
 * compromise this list defends against.
 */
export const rpcHostAllowlist: Readonly<
  Partial<
    Record<
      DeploymentEnvironment,
      { rpc: readonly string[]; horizon: readonly string[] }
    >
  >
> = {
  production: { rpc: MAINNET_RPC_HOSTS, horizon: MAINNET_HORIZON_HOSTS },
  mainnet: { rpc: MAINNET_RPC_HOSTS, horizon: MAINNET_HORIZON_HOSTS },
  staging: { rpc: TESTNET_RPC_HOSTS, horizon: TESTNET_HORIZON_HOSTS },
  pilot: { rpc: TESTNET_RPC_HOSTS, horizon: TESTNET_HORIZON_HOSTS },
};

/** Hostname suffixes that only ever resolve inside a private network. */
const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".intranet",
  ".corp",
  ".home.arpa",
];

type RpcEndpointKind = "rpc" | "horizon";

export type RuntimeConfig = {
  deployment: DeploymentEnvironment;
  isProduction: boolean;
  isPreview: boolean;
  buildRevision: string;
  schemaCompatibility: string;
  attestation: {
    mode: z.infer<typeof attestationModeSchema>;
    contractConfigured: boolean;
    protocolConfigured: boolean;
    /** Governance-approved contract WASM hashes (issue #629). Public values. */
    approvedWasmHashes: string[];
  };
  payoutIndexer: { enabled: boolean };
  sentry: { enabled: boolean };
  database: {
    /** Transaction-mode pooler URL for runtime/serverless access. */
    poolerUrl?: string;
    /** Transaction-mode pooler URL for migrations and scripts. */
    directUrl?: string;
    /** True when a transaction-mode pooler is configured. */
    poolerConfigured: boolean;
  };
};

/**
 * Value-free by default -- suitable for startup logs without ever leaking a
 * secret. `details` may add extra human-readable context (e.g. which
 * variable *names*, never their values, are missing) so a contributor can
 * fix their local .env without having to read this file.
 */
export class RuntimeConfigError extends Error {
  constructor(
    readonly code: string,
    details?: string,
  ) {
    super(
      details
        ? `INVALID_RUNTIME_CONFIGURATION:${code} -- ${details}`
        : `INVALID_RUNTIME_CONFIGURATION:${code}`,
    );
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

function normalizedHostname(url: URL): string {
  // URL keeps IPv6 literals bracketed ("[::1]") and may keep a trailing dot.
  return url.hostname
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
}

function isPrivateHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    // A single-label name resolves through the local search domain only.
    !hostname.includes(".") ||
    PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

/**
 * Validates one configured Stellar endpoint. Throws a value-free
 * RuntimeConfigError naming the variable (never its value -- a provider URL
 * can embed an API key in its path).
 */
function validateRpcUrl(
  variable: "SOROBAN_RPC_URL" | "STELLAR_HORIZON_URL",
  kind: RpcEndpointKind,
  value: string,
  deployment: DeploymentEnvironment,
): void {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RuntimeConfigError(
      "RPC_URL_UNSUPPORTED_SCHEME",
      `${variable} must be an http(s) URL`,
    );
  }

  const allowlist = rpcHostAllowlist[deployment];
  if (!ALLOWLISTED_DEPLOYMENTS.has(deployment) || !allowlist) return;

  if (url.protocol !== "https:") {
    throw new RuntimeConfigError(
      "RPC_URL_INSECURE_SCHEME",
      `${variable} must use https in the '${deployment}' deployment`,
    );
  }
  const hostname = normalizedHostname(url);
  if (isIP(hostname) !== 0) {
    throw new RuntimeConfigError(
      "RPC_URL_IP_LITERAL",
      `${variable} must use a DNS hostname, not an IP address, in the '${deployment}' deployment`,
    );
  }
  if (isPrivateHostname(hostname)) {
    throw new RuntimeConfigError(
      "RPC_URL_PRIVATE_HOST",
      `${variable} points at a local or private-network host, which is not allowed in the '${deployment}' deployment`,
    );
  }
  if (!allowlist[kind].includes(hostname)) {
    throw new RuntimeConfigError(
      "RPC_URL_HOST_NOT_ALLOWED",
      `${variable} host is not in rpcHostAllowlist.${deployment}.${kind} (lib/runtime-config.ts)`,
    );
  }
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
    DATABASE_URL: env.DATABASE_URL,
    DIRECT_URL: env.DIRECT_URL,
    STELLAR_NETWORK_PASSPHRASE: env.STELLAR_NETWORK_PASSPHRASE,
    SOROBAN_RPC_URL: env.SOROBAN_RPC_URL,
    LAFIYA_DEPLOYMENT_ENV: env.LAFIYA_DEPLOYMENT_ENV,
    ATTESTATION_MODE: env.ATTESTATION_MODE,
    ATTESTATION_CONTRACT_ID: env.ATTESTATION_CONTRACT_ID,
    ATTESTATION_CACHE_TTL_SECONDS: env.ATTESTATION_CACHE_TTL_SECONDS,
    ATTESTATION_APPROVED_WASM_HASHES: env.ATTESTATION_APPROVED_WASM_HASHES,
    ACCOUNT_LINKAGE_HMAC_SECRET: env.ACCOUNT_LINKAGE_HMAC_SECRET,
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
    PAYOUT_INDEXER_CRON_SECRET_PREVIOUS:
      env.PAYOUT_INDEXER_CRON_SECRET_PREVIOUS,
    SENTRY_ENABLED: env.SENTRY_ENABLED,
    NEXT_PUBLIC_SENTRY_DSN: env.NEXT_PUBLIC_SENTRY_DSN,
    SENTRY_DSN: env.SENTRY_DSN,
    LAFIYA_BUILD_REVISION: env.LAFIYA_BUILD_REVISION,
    LAFIYA_SCHEMA_COMPATIBILITY: env.LAFIYA_SCHEMA_COMPATIBILITY,
    TRUSTED_PROXY_HOPS: env.TRUSTED_PROXY_HOPS,
    CLIENT_IP_HEADER: env.CLIENT_IP_HEADER,
  });
  if (!parsed.success) {
    const missingOrInvalid = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new RuntimeConfigError(
      "MALFORMED_VALUE",
      `missing or invalid required environment variable(s): ${missingOrInvalid.join(", ")}. ` +
        "Set them in your .env (see .env.example) and restart.",
    );
  }

  const config = parsed.data;
  const deployment = inferDeployment(env);
  const isProduction = deployment === "production" || deployment === "mainnet";
  const isPreview = deployment === "preview";
  const attestationMode =
    config.ATTESTATION_MODE ??
    (config.ATTESTATION_CONTRACT_ID || isProduction ? "live" : "mock");
  const protocolConfigured = Boolean(
    config.CHW_PROTOCOL_EPOCH_ID && config.CHW_PROTOCOL_INTENT_SIGNING_KEY,
  );

  // Web Push is enabled only when the full VAPID triple is present. A
  // partially configured deployment is a misconfiguration, not a silent
  // no-op, so it fails fast below.
  const webPushConfigured = Boolean(
    config.NEXT_PUBLIC_VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY,
  );
  const webPushPartiallyConfigured =
    !webPushConfigured &&
    Boolean(
      config.NEXT_PUBLIC_VAPID_PUBLIC_KEY ||
        config.VAPID_PRIVATE_KEY ||
        config.VAPID_SUBJECT,
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
    // Serverless runtimes must reach Postgres through the transaction-mode
    // pooler; a missing pooler URL in production is a connection-exhaustion
    // incident waiting to happen.
    requireConfigured(config.DATABASE_URL, "POOLER_URL_REQUIRED");
  }

  requireConfigured(
    !webPushPartiallyConfigured,
    "WEB_PUSH_CONFIG_INCOMPLETE",
  );

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

  const approvedWasmHashes = (config.ATTESTATION_APPROVED_WASM_HASHES ?? "")
    .split(",")
    .map((hash) => hash.trim().toLowerCase())
    .filter(Boolean);
  requireConfigured(
    approvedWasmHashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)),
    "APPROVED_WASM_HASH_INVALID",
  );

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
  ];
  if (config.PAYOUT_INDEXER_ENABLED) {
    requireConfigured(
      indexerSettings.every(Boolean),
      "PAYOUT_INDEXER_CONFIG_INCOMPLETE",
    );
    requireConfigured(
      isStellarPublicKey(config.STELLAR_USDC_ISSUER),
      "PAYOUT_INDEXER_USDC_ISSUER_INVALID",
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
    requireConfigured(
      !config.PAYOUT_INDEXER_CRON_SECRET_PREVIOUS ||
        config.PAYOUT_INDEXER_CRON_SECRET_PREVIOUS.length >= 32,
      "CRON_PREVIOUS_SECRET_TOO_SHORT",
    );
  } else {
    requireConfigured(
      [...indexerSettings, config.PAYOUT_INDEXER_CRON_SECRET_PREVIOUS].every(
        (value) => value === undefined,
      ),
      "PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION",
    );
    requireConfigured(
      config.PAYOUT_INDEXER_CRON_SECRET_PREVIOUS === undefined,
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
    buildRevision: config.LAFIYA_BUILD_REVISION ?? "unknown",
    schemaCompatibility:
      config.LAFIYA_SCHEMA_COMPATIBILITY ?? CURRENT_SCHEMA_COMPATIBILITY,
    attestation: {
      mode: attestationMode,
      contractConfigured: Boolean(config.ATTESTATION_CONTRACT_ID),
      protocolConfigured,
      approvedWasmHashes,
    },
    payoutIndexer: { enabled: config.PAYOUT_INDEXER_ENABLED },
    sentry: { enabled: config.SENTRY_ENABLED },
    database: {
      poolerUrl: config.DATABASE_URL,
      directUrl: config.DIRECT_URL,
      poolerConfigured: Boolean(config.DATABASE_URL),
    },
  };
}
