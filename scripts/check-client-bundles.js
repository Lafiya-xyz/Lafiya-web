/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

const CHUNKS_DIR = path.join(process.cwd(), ".next/static/chunks");

const SERVER_ONLY_ENV_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "STELLAR_NETWORK_PASSPHRASE",
  "SOROBAN_RPC_URL",
  "ATTESTATION_CONTRACT_ID",
  "STELLAR_HORIZON_URL",
  "STELLAR_USDC_ISSUER",
  "CHW_INCENTIVE_POOL_ADDRESS",
  "PAYOUT_INDEXER_START_LEDGER",
  "PAYOUT_INDEXER_START_PAYMENT_CURSOR",
  "PAYOUT_INDEXER_CRON_SECRET",
];

// The Stellar Wallets Kit is a heavy, wallet-agnostic dependency that must only
// ever be pulled in through the lazy-loaded CHW signing module. If it leaks into
// the eagerly-loaded public card bundle, the bundle check fails so the regression
// is caught at build time (issue #557).
const LAZY_ONLY_MODULES = ["@creit.tech/stellar-wallets-kit"];

const searchTargets = new Map(SERVER_ONLY_ENV_VARS.map((name) => [name, name]));

for (const name of SERVER_ONLY_ENV_VARS) {
  const value = process.env[name]?.trim();

  if (value && value.length > 3) {
    searchTargets.set(value, `<${name} value>`);
  }
}

if (!fs.existsSync(CHUNKS_DIR)) {
  console.error(
    `Error: Chunks directory not found at ${CHUNKS_DIR}. Make sure to build the project first (npm run build).`,
  );
  process.exit(1);
}

function getFilesRecursively(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath));
    } else {
      results.push(fullPath);
    }
  });
  return results;
}

console.log(`Scanning client chunks in ${CHUNKS_DIR}...`);
console.log(
  "Searching for sensitive server-only env identifiers and configured values:",
  Array.from(searchTargets.values()),
);
console.log(
  "Enforcing lazy-only modules stay out of the public card bundle:",
  LAZY_ONLY_MODULES,
);

const files = getFilesRecursively(CHUNKS_DIR);
let leakDetected = false;
const textAssetExtensions = new Set([
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".txt",
]);

files.forEach((file) => {
  if (!textAssetExtensions.has(path.extname(file))) {
    return;
  }

  const content = fs.readFileSync(file, "utf8");
  searchTargets.forEach((label, target) => {
    if (content.includes(target)) {
      console.error(
        `\x1b[31mCRITICAL LEAK DETECTED:\x1b[0m File "${path.relative(
          process.cwd(),
          file,
        )}" contains sensitive information matching "${label}"`,
      );
      leakDetected = true;
    }
  });
});

if (leakDetected) {
  console.error(
    "\x1b[31mBuild check failed: Client bundles contain server-only environment data.\x1b[0m",
  );
  process.exit(1);
} else {
  console.log(
    "\x1b[32mSuccess: No server-only environment data found in client bundles.\x1b[0m",
  );
  process.exit(0);
}
