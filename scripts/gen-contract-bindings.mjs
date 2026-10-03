#!/usr/bin/env node
// Generates typed TypeScript bindings for the attestation Soroban contract
// from its on-chain spec, so `lib/stellar/attestation.ts` never hand-decodes
// ScVal values. Run via `npm run gen:contract-bindings`.
//
// The generator version is pinned (see STELLAR_CLI_VERSION) so that CI drift
// checks are reproducible across machines.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Pinned generator version. Bump deliberately and regenerate bindings.
const STELLAR_CLI_VERSION = "22.0.1";

const NETWORKS = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  mainnet: {
    rpcUrl: "https://soroban-mainnet.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
};

function parseArgs(argv) {
  const args = { network: process.env.STELLAR_NETWORK || "testnet" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--network" && argv[i + 1]) {
      args.network = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--network=")) {
      args.network = arg.slice("--network=".length);
    }
  }
  return args;
}

function resolveContractId(network) {
  const envKey = `ATTESTATION_CONTRACT_ID_${network.toUpperCase()}`;
  const contractId =
    process.env[envKey] ||
    process.env.ATTESTATION_CONTRACT_ID ||
    process.env.NEXT_PUBLIC_ATTESTATION_CONTRACT_ID;
  if (!contractId) {
    throw new Error(
      `Missing contract id. Set ${envKey} (or ATTESTATION_CONTRACT_ID) before generating bindings.`,
    );
  }
  return contractId;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    ...options,
  });
}

function main() {
  const { network } = parseArgs(process.argv.slice(2));
  const config = NETWORKS[network];
  if (!config) {
    throw new Error(
      `Unknown network "${network}". Expected one of: ${Object.keys(NETWORKS).join(", ")}.`,
    );
  }

  const contractId = resolveContractId(network);
  const outDir = resolve(repoRoot, "lib/stellar/generated");

  // Regenerate from scratch so stale files never linger in the diff.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  console.log(
    `Generating attestation bindings for ${network} (${contractId}) using stellar-cli@${STELLAR_CLI_VERSION}...`,
  );

  run("npx", [
    "--yes",
    `@stellar/stellar-cli@${STELLAR_CLI_VERSION}`,
    "contract",
    "bindings",
    "typescript",
    "--id",
    contractId,
    "--network",
    network,
    "--rpc-url",
    config.rpcUrl,
    "--network-passphrase",
    config.networkPassphrase,
    "--output-dir",
    outDir,
  ]);

  console.log(`Bindings written to ${outDir}`);
}

main();
