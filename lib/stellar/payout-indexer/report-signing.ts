/**
 * Ed25519 signing/verification for funder reports.
 *
 * Reuses the Stellar keypair primitives already a dependency
 * (`@stellar/stellar-sdk`'s `Keypair` wraps libsodium/tweetnacl Ed25519, the
 * same signature scheme SEP-1/stellar.toml expects for a SIGNING_KEY), so no
 * new crypto dependency is introduced. The report-signing key is a distinct
 * keypair from any on-chain payout account -- it never moves funds, it only
 * signs report bytes -- and should be provisioned separately.
 */

import { Keypair } from "@stellar/stellar-sdk";

export interface SignedReport {
  /** base64-encoded detached Ed25519 signature over the canonical report bytes. */
  signature: string;
  /** Stellar-format (G...) public key of the signer, publishable in stellar.toml. */
  signerPublicKey: string;
}

export function signReportBytes(bytes: Buffer, signingKeypair: Keypair): SignedReport {
  const signature = signingKeypair.sign(bytes);
  return {
    signature: signature.toString("base64"),
    signerPublicKey: signingKeypair.publicKey(),
  };
}

export function verifyReportSignature(
  bytes: Buffer,
  signature: string,
  signerPublicKey: string,
): boolean {
  const keypair = Keypair.fromPublicKey(signerPublicKey);
  return keypair.verify(bytes, Buffer.from(signature, "base64"));
}

/** Loads the server-side signing key from env (never logged, never sent to a third party). */
export function loadReportSigningKeypair(secretSeed: string): Keypair {
  return Keypair.fromSecret(secretSeed);
}
