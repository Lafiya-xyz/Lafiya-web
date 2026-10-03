import { describe, expect, it, vi } from "vitest";

import {
  CURRENT_SCHEMA_COMPATIBILITY,
  getRpcResolutionStatus,
  getRuntimeConfig,
  isPrivateAddress,
  verifyRpcHostResolution,
} from "./runtime-config";

const baseEnv = {
  LAFIYA_DEPLOYMENT_ENV: "preview",
  NEXT_PUBLIC_SUPABASE_URL: "https://branch-preview.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  LAFIYA_ATTESTATION_MODE: "mock",
  LAFIYA_CHAIN_NETWORK: "testnet",
} as const;

type EnvOverrides = Record<string, string | undefined>;

function baseEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    STELLAR_NETWORK_PASSPHRASE: TESTNET,
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function productionEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return baseEnv({
    NODE_ENV: "production",
    LAFIYA_DEPLOYMENT_ENV: "production",
    LAFIYA_BUILD_REVISION: "a1b2c3d4",
    LAFIYA_SCHEMA_COMPATIBILITY: CURRENT_SCHEMA_COMPATIBILITY,
    STELLAR_NETWORK_PASSPHRASE: MAINNET,
    SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.com",
    ATTESTATION_MODE: "live",
    ATTESTATION_CONTRACT_ID: CONTRACT_ID,
    CHW_PROTOCOL_EPOCH_ID: "epoch-2026-08",
    CHW_PROTOCOL_INTENT_SIGNING_KEY: "managed-signing-key-reference",
    SENTRY_ENABLED: "true",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    ...overrides,
  });
}

describe("runtime configuration matrix", () => {
  it("keeps intentional local mock mode explicit and non-production", () => {
    expect(
      getRuntimeConfig(
        baseEnv({
          LAFIYA_DEPLOYMENT_ENV: "development",
          ATTESTATION_MODE: "mock",
        }),
      ),
    ).toMatchObject({
      deployment: "development",
      isProduction: false,
      attestation: { mode: "mock", contractConfigured: false },
      payoutIndexer: { enabled: false },
    });
  });

  it("rejects an unlabeled production process and production mock mode", () => {
    expect(() => getRuntimeConfig(baseEnv({ NODE_ENV: "production" }))).toThrow(
      "DEPLOYMENT_IDENTITY_REQUIRED",
    );
    expect(() =>
      getRuntimeConfig(
        productionEnv({
          ATTESTATION_MODE: "mock",
          ATTESTATION_CONTRACT_ID: undefined,
        }),
      ),
    ).toThrow("PRODUCTION_MOCK_FORBIDDEN");
  });

  it("rejects testnet, stale schema, or absent telemetry in production", () => {
    expect(() =>
      getRuntimeConfig(productionEnv({ STELLAR_NETWORK_PASSPHRASE: TESTNET })),
    ).toThrow("MAINNET_NETWORK_REQUIRED");
    expect(() =>
      getRuntimeConfig(
        productionEnv({ LAFIYA_SCHEMA_COMPATIBILITY: "20260101000000" }),
      ),
    ).toThrow("SCHEMA_COMPATIBILITY_MISMATCH");
    expect(() =>
      getRuntimeConfig(
        productionEnv({ SENTRY_ENABLED: "false", SENTRY_DSN: undefined }),
      ),
    ).toThrow("SENTRY_REQUIRED");
  });

  it("requires a real contract and complete protocol in live mode", () => {
    expect(() =>
      getRuntimeConfig(baseEnv({ ATTESTATION_MODE: "live" })),
    ).toThrow("LIVE_ATTESTATION_CONTRACT_REQUIRED");
    expect(() =>
      getRuntimeConfig(
        productionEnv({ CHW_PROTOCOL_INTENT_SIGNING_KEY: undefined }),
      ),
    ).toThrow("PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE");
  });

  it("treats the payout indexer as an all-or-nothing, live-only feature group", () => {
    expect(() =>
      getRuntimeConfig(
        baseEnv({
          PAYOUT_INDEXER_ENABLED: "true",
          ATTESTATION_MODE: "live",
          ATTESTATION_CONTRACT_ID: CONTRACT_ID,
        }),
      ),
    ).toThrow("PAYOUT_INDEXER_CONFIG_INCOMPLETE");
    expect(() =>
      getRuntimeConfig(
        baseEnv({ STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org" }),
      ),
    ).toThrow("PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION");

    const completeIndexerEnv: EnvOverrides = {
      ATTESTATION_MODE: "live",
      ATTESTATION_CONTRACT_ID: CONTRACT_ID,
      PAYOUT_INDEXER_ENABLED: "true",
      STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      STELLAR_USDC_ISSUER: PUBLIC_KEY,
      STELLAR_USDC_ASSET_CODE: "USDC",
      CHW_INCENTIVE_POOL_ADDRESS: PUBLIC_KEY,
      PAYOUT_INDEXER_START_LEDGER: "123",
      PAYOUT_INDEXER_START_PAYMENT_CURSOR: "0",
      PAYOUT_INDEXER_CRON_SECRET: "a".repeat(32),
      PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "b".repeat(32),
    };

    expect(
      getRuntimeConfig(baseEnv(completeIndexerEnv)).payoutIndexer,
    ).toEqual({ enabled: true });
    expect(
      getRuntimeConfig(
        baseEnv({
          ...completeIndexerEnv,
          PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: undefined,
        }),
      ).payoutIndexer,
    ).toEqual({ enabled: true });

    expect(() =>
      getRuntimeConfig(
        baseEnv({
          ...completeIndexerEnv,
          PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "short",
        }),
      ),
    ).toThrow("CRON_PREVIOUS_SECRET_TOO_SHORT");

    expect(() =>
      getRuntimeConfig(
        baseEnv({ PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "b".repeat(32) }),
      ),
    ).toThrow("PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION");
  });

  it("returns only non-secret readiness configuration", () => {
    const config = getRuntimeConfig(productionEnv());
    expect(config).toEqual({
      deployment: "production",
      isProduction: true,
      buildRevision: "a1b2c3d4",
      schemaCompatibility: CURRENT_SCHEMA_COMPATIBILITY,
      attestation: {
        mode: "live",
        contractConfigured: true,
        protocolConfigured: true,
        approvedWasmHashes: [],
      },
      payoutIndexer: { enabled: false },
      sentry: { enabled: true },
      rpcEndpoints: { policy: "allowlist" },
    });
    expect(JSON.stringify(config)).not.toContain(
      "managed-signing-key-reference",
    );
  });

  it("parses the approved attestation WASM hash allowlist (issue #629)", () => {
    const hash = "A".repeat(64);
    expect(
      getRuntimeConfig(
        productionEnv({ ATTESTATION_APPROVED_WASM_HASHES: ` ${hash}, ` }),
      ).attestation.approvedWasmHashes,
    ).toEqual(["a".repeat(64)]);
    expect(() =>
      getRuntimeConfig(
        productionEnv({ ATTESTATION_APPROVED_WASM_HASHES: "not-a-hash" }),
      ),
    ).toThrow("APPROVED_WASM_HASH_INVALID");
  });
});

describe("runtime configuration — additional negative test cases", () => {
  // #396: verify every value consumed from runtime-config is validated at
  // load time, mirroring the standard set by lib/env.ts / lib/env-server.ts.

  it("rejects a malformed URL for NEXT_PUBLIC_SUPABASE_URL", () => {
    expect(() =>
      getRuntimeConfig(
        baseEnv({ NEXT_PUBLIC_SUPABASE_URL: "not-a-valid-url" }),
      ),
    ).toThrow("MALFORMED_VALUE");
  });

  it("rejects a malformed URL for SOROBAN_RPC_URL", () => {
    expect(() =>
      getRuntimeConfig(baseEnv({ SOROBAN_RPC_URL: "not-a-url" })),
    ).toThrow("MALFORMED_VALUE");
  });

  it("rejects an unknown ATTESTATION_MODE value", () => {
    expect(() =>
      getRuntimeConfig(baseEnv({ ATTESTATION_MODE: "unknown-mode" })),
    ).toThrow("MALFORMED_VALUE");
  });

  it("forces mock attestations in previews", () => {
    const config = resolveRuntimeConfig({ ...baseEnv, LAFIYA_ATTESTATION_MODE: "live" });
    expect(config.attestationMode).toBe("mock");
  });

  it("rejects previews that point at mainnet", () => {
    expect(() =>
      resolveRuntimeConfig({ ...baseEnv, LAFIYA_CHAIN_NETWORK: "mainnet" }),
    ).toThrow(/mainnet/i);
  });

  it("rejects previews that reuse the shared staging database", () => {
    expect(() =>
      resolveRuntimeConfig({
        ...baseEnv,
        NEXT_PUBLIC_SUPABASE_URL: "https://staging.supabase.co",
      }),
    ).toThrow(/isolated/i);
  });

  it("accepts a well-formed preview configuration", () => {
    const config = resolveRuntimeConfig(baseEnv);
    expect(config.deploymentEnv).toBe("preview");
    expect(config.attestationMode).toBe("mock");
    expect(config.chainNetwork).toBe("testnet");
    expect(() => assertPreviewGuardrails(baseEnv)).not.toThrow();
  });
});

function indexerEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  return baseEnv({
    ATTESTATION_MODE: "live",
    ATTESTATION_CONTRACT_ID: CONTRACT_ID,
    PAYOUT_INDEXER_ENABLED: "true",
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_USDC_ISSUER: PUBLIC_KEY,
    STELLAR_USDC_ASSET_CODE: "USDC",
    CHW_INCENTIVE_POOL_ADDRESS: PUBLIC_KEY,
    PAYOUT_INDEXER_START_LEDGER: "123",
    PAYOUT_INDEXER_START_PAYMENT_CURSOR: "0",
    PAYOUT_INDEXER_CRON_SECRET: "a".repeat(32),
    ...overrides,
  });
}

describe("payout indexer cron secret rotation (#518)", () => {
  it("accepts a previous secret alongside the current one", () => {
    expect(
      getRuntimeConfig(
        indexerEnv({ PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "b".repeat(32) }),
      ).payoutIndexer,
    ).toEqual({ enabled: true });
  });

  it("rejects a short previous secret or one equal to the current secret", () => {
    expect(() =>
      getRuntimeConfig(
        indexerEnv({ PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "short" }),
      ),
    ).toThrow("CRON_SECRET_PREVIOUS_TOO_SHORT");
    expect(() =>
      getRuntimeConfig(
        indexerEnv({ PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "a".repeat(32) }),
      ),
    ).toThrow("CRON_SECRET_PREVIOUS_MATCHES_CURRENT");
  });

  it("rejects a previous secret when the indexer is disabled", () => {
    expect(() =>
      getRuntimeConfig(
        baseEnv({ PAYOUT_INDEXER_CRON_SECRET_PREVIOUS: "b".repeat(32) }),
      ),
    ).toThrow("PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION");
  });
});

describe("RPC/Horizon URL allowlist (#525)", () => {
  const stagingEnv = (overrides: EnvOverrides = {}) =>
    baseEnv({
      LAFIYA_DEPLOYMENT_ENV: "staging",
      ATTESTATION_MODE: "live",
      ATTESTATION_CONTRACT_ID: CONTRACT_ID,
      ...overrides,
    });

  it.each([
    ["non-https scheme", "http://mainnet.sorobanrpc.com", "RPC_URL_INSECURE_SCHEME"],
    ["non-http scheme", "ftp://mainnet.sorobanrpc.com", "RPC_URL_UNSUPPORTED_SCHEME"],
    ["IPv4 literal", "https://203.0.113.10", "RPC_URL_IP_LITERAL"],
    ["metadata IPv4 literal", "https://169.254.169.254/latest", "RPC_URL_IP_LITERAL"],
    ["integer-encoded IPv4 literal", "https://2130706433", "RPC_URL_IP_LITERAL"],
    ["IPv6 literal", "https://[2001:db8::1]", "RPC_URL_IP_LITERAL"],
    ["IPv6 loopback literal", "https://[::1]:8000", "RPC_URL_IP_LITERAL"],
    ["localhost", "https://localhost:8000", "RPC_URL_PRIVATE_HOST"],
    ["*.localhost", "https://rpc.localhost", "RPC_URL_PRIVATE_HOST"],
    ["*.internal", "https://metadata.google.internal", "RPC_URL_PRIVATE_HOST"],
    ["*.local", "https://stellar-node.local", "RPC_URL_PRIVATE_HOST"],
    ["single-label host", "https://rpc", "RPC_URL_PRIVATE_HOST"],
    ["unlisted host", "https://rpc.attacker.example", "RPC_URL_HOST_NOT_ALLOWED"],
    ["lookalike suffix", "https://mainnet.sorobanrpc.com.attacker.example", "RPC_URL_HOST_NOT_ALLOWED"],
    ["testnet host in production", "https://soroban-testnet.stellar.org", "RPC_URL_HOST_NOT_ALLOWED"],
  ])("production rejects SOROBAN_RPC_URL with a %s", (_label, url, code) => {
    expect(() =>
      getRuntimeConfig(productionEnv({ SOROBAN_RPC_URL: url })),
    ).toThrow(code);
  });

  it("names the variable but never echoes the URL in the error", () => {
    const secretPath = "https://rpc.attacker.example/api=SECRETKEY";
    expect(() =>
      getRuntimeConfig(productionEnv({ SOROBAN_RPC_URL: secretPath })),
    ).toThrow(/SOROBAN_RPC_URL/);
    expect(() =>
      getRuntimeConfig(productionEnv({ SOROBAN_RPC_URL: secretPath })),
    ).not.toThrow(/SECRETKEY|attacker/);
  });

  it.each([
    ["mainnet host in staging", "https://mainnet.sorobanrpc.com", "RPC_URL_HOST_NOT_ALLOWED"],
    ["http localhost in staging", "http://localhost:8000", "RPC_URL_INSECURE_SCHEME"],
    ["private IP in staging", "https://10.0.0.5", "RPC_URL_IP_LITERAL"],
  ])("staging rejects a %s", (_label, url, code) => {
    expect(() => getRuntimeConfig(stagingEnv({ SOROBAN_RPC_URL: url }))).toThrow(
      code,
    );
  });

  it("applies the same rules to STELLAR_HORIZON_URL", () => {
    expect(() =>
      getRuntimeConfig(
        indexerEnv({
          LAFIYA_DEPLOYMENT_ENV: "staging",
          STELLAR_HORIZON_URL: "https://horizon.attacker.example",
        }),
      ),
    ).toThrow("RPC_URL_HOST_NOT_ALLOWED");
    expect(() =>
      getRuntimeConfig(
        indexerEnv({
          LAFIYA_DEPLOYMENT_ENV: "staging",
          STELLAR_HORIZON_URL: "https://soroban-testnet.stellar.org",
        }),
      ),
    ).toThrow("RPC_URL_HOST_NOT_ALLOWED");
    expect(
      getRuntimeConfig(indexerEnv({ LAFIYA_DEPLOYMENT_ENV: "staging" }))
        .rpcEndpoints,
    ).toEqual({ policy: "allowlist" });
  });

  it("accepts allowlisted hosts, case- and trailing-dot-insensitively", () => {
    for (const url of [
      "https://mainnet.sorobanrpc.com",
      "https://MAINNET.SorobanRPC.com/",
      "https://mainnet.sorobanrpc.com./",
      "https://soroban-rpc.mainnet.stellar.gateway.fm",
    ]) {
      expect(
        getRuntimeConfig(productionEnv({ SOROBAN_RPC_URL: url })).rpcEndpoints,
      ).toEqual({ policy: "allowlist" });
    }
  });

  it.each(["development", "test", "ci", "preview"])(
    "keeps http://localhost usable in %s",
    (deployment) => {
      const config = getRuntimeConfig(
        baseEnv({
          LAFIYA_DEPLOYMENT_ENV: deployment,
          SOROBAN_RPC_URL: "http://localhost:8000/soroban/rpc",
        }),
      );
      expect(config.rpcEndpoints).toEqual({ policy: "permissive" });
    },
  );

  it("still rejects non-http schemes in permissive deployments", () => {
    expect(() =>
      getRuntimeConfig(
        baseEnv({
          LAFIYA_DEPLOYMENT_ENV: "development",
          SOROBAN_RPC_URL: "file:///etc/passwd",
        }),
      ),
    ).toThrow("RPC_URL_UNSUPPORTED_SCHEME");
  });
});

describe("isPrivateAddress", () => {
  it.each([
    ["127.0.0.1", true],
    ["10.1.2.3", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["169.254.169.254", true],
    ["100.64.0.1", true],
    ["0.0.0.0", true],
    ["::1", true],
    ["::", true],
    ["fd00::1", true],
    ["fe80::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::ffff:a9fe:a9fe", true],
    ["not-an-ip", true],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["2001:4860:4860::8888", false],
    ["::ffff:8.8.8.8", false],
  ])("%s -> %s", (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe("verifyRpcHostResolution (#525)", () => {
  const publicLookup = async () => [{ address: "203.0.113.10" }];

  it("skips DNS checks in permissive deployments", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(verifyRpcHostResolution(baseEnv(), lookup)).resolves.toBe(
      "skipped",
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(getRpcResolutionStatus()).toBe("skipped");
  });

  it("verifies that allowlisted hosts resolve to public addresses", async () => {
    const lookup = vi.fn(publicLookup);
    await expect(
      verifyRpcHostResolution(productionEnv(), lookup),
    ).resolves.toBe("verified");
    expect(lookup).toHaveBeenCalledWith("mainnet.sorobanrpc.com");
    expect(getRpcResolutionStatus()).toBe("verified");
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["RFC 1918", "10.0.0.8"],
    ["IPv6 unique-local", "fd12::1"],
  ])("refuses to boot when a host resolves to a %s address", async (_l, ip) => {
    const lookup = async () => [{ address: "203.0.113.10" }, { address: ip }];
    await expect(verifyRpcHostResolution(productionEnv(), lookup)).rejects.toThrow(
      "RPC_URL_RESOLVES_PRIVATE",
    );
  });

  it("fails closed when a host does not resolve", async () => {
    const lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(verifyRpcHostResolution(productionEnv(), lookup)).rejects.toThrow(
      "RPC_URL_UNRESOLVABLE",
    );
  });
});
