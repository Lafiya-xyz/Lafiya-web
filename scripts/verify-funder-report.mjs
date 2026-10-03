#!/usr/bin/env node
/**
 * Verifies a funder report's detached Ed25519 signature.
 *
 * Usage:
 *   node scripts/verify-funder-report.mjs <report.json> <signature.b64> <signerPublicKey>
 *
 * The report JSON must be the canonical (signed) form -- i.e. the object
 * produced by canonicalReportBytes() in
 * lib/stellar/payout-indexer/funder-report.ts: { schemaVersion, period, rows },
 * WITHOUT a generatedAt field. Funders receive this file, the .sig file, and
 * the signer's public key (published in stellar.toml / docs) alongside the
 * human-readable report.
 *
 * This script intentionally has no dependency beyond @stellar/stellar-sdk,
 * already a project dependency, so it can be run standalone by a funder
 * with only Node.js and `npm install @stellar/stellar-sdk` -- no access to
 * the rest of this repo or its database is required or possible.
 */

import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

const [, , reportPath, signaturePath, signerPublicKey] = process.argv;

if (!reportPath || !signaturePath || !signerPublicKey) {
  console.error(
    "Usage: node verify-funder-report.mjs <report.json> <signature.b64> <signerPublicKey>",
  );
  process.exit(2);
}

const reportBytes = readFileSync(reportPath);
const signatureB64 = readFileSync(signaturePath, "utf8").trim();

let verified;
try {
  const keypair = Keypair.fromPublicKey(signerPublicKey);
  verified = keypair.verify(reportBytes, Buffer.from(signatureB64, "base64"));
} catch (err) {
  console.error(`Verification error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (verified) {
  console.log("OK: signature is valid for the given report and public key.");
  process.exit(0);
} else {
  console.error("FAILED: signature does not match the report bytes and/or public key.");
  process.exit(1);
}
