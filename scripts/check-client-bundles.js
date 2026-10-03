#!/usr/bin/env node
/**
 * Client bundle budget check.
 *
 * Enforces a zero-client-component policy on public card routes (`/card/*`).
 * The emergency card must be a pure server-rendered page apart from an
 * explicitly allowlisted set of islands (for example, service worker
 * registration). Any other client component reachable from the card layout or
 * page will fail this check.
 *
 * Usage:
 *   node scripts/check-client-bundles.js
 *
 * Exits non-zero when the card route's client JS exceeds the allowlist or the
 * byte budget, so CI fails on regressions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, '.next');

// Explicit allowlist of client islands permitted on `/card/*`.
// Keep this list as small as possible: every entry is client JS shipped to
// low-end devices and a wider CSP surface.
const CARD_CLIENT_ALLOWLIST = [
  // Service worker registration is the only island we accept on the card.
  'service-worker-registration',
];

// The Stellar Wallets Kit is a heavy, wallet-agnostic dependency that must only
// ever be pulled in through the lazy-loaded CHW signing module. If it leaks into
// the eagerly-loaded public card bundle, the bundle check fails so the regression
// is caught at build time (issue #557).
const LAZY_ONLY_MODULES = ["@creit.tech/stellar-wallets-kit"];

const searchTargets = new Map(SERVER_ONLY_ENV_VARS.map((name) => [name, name]));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collectClientChunks() {
  const manifestPath = path.join(BUILD_DIR, 'app-build-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return readJson(manifestPath);
}

function isCardRoute(route) {
  return CARD_ROUTE_PREFIXES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`)
  );
}

function isAllowlisted(chunkPath) {
  return CARD_CLIENT_ALLOWLIST.some((name) => chunkPath.includes(name));
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

  let ok = true;
  let totalBytes = 0;

  for (const route of cardRoutes) {
    const files = manifest[route] || [];
    for (const file of files) {
      if (!file.endsWith('.js')) {
        continue;
      }
      if (isAllowlisted(file)) {
        continue;
      }
      const abs = path.join(BUILD_DIR, file);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch (err) {
        // Missing chunk: treat as a violation so stale manifests are caught.
        console.error(
          `[check-client-bundles] Missing client chunk for card route ${route}: ${file}`
        );
        ok = false;
        continue;
      }
      totalBytes += size;
      console.error(
        `[check-client-bundles] Disallowed client component on card route ${route}: ${file} (${size} bytes). ` +
          'Card routes must be server-rendered; add the island to CARD_CLIENT_ALLOWLIST only if it is explicitly approved.'
      );
      ok = false;
    }
  }

  if (totalBytes > CARD_CLIENT_BYTE_BUDGET) {
    console.error(
      `[check-client-bundles] Card route client JS is ${totalBytes} bytes, exceeding the ${CARD_CLIENT_BYTE_BUDGET} byte budget.`
    );
    ok = false;
  }

  if (ok) {
    console.log(
      `[check-client-bundles] Card route client JS is within budget (${totalBytes}/${CARD_CLIENT_BYTE_BUDGET} bytes).`
    );
  }

  return ok;
}

function main() {
  const ok = checkCardRouteBudget();
  if (!ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CARD_CLIENT_ALLOWLIST,
  CARD_CLIENT_BYTE_BUDGET,
  CARD_ROUTE_PREFIXES,
  isCardRoute,
  isAllowlisted,
  checkCardRouteBudget,
};
