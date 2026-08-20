import { createHash } from "node:crypto";

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

/**
 * Spike PoC — CHW identity ↔ Stellar-address binding and signing primitives
 * (see docs/chw-identity-spike.md; issue issues/roadmap-12-chw-identity.md).
 *
 * Demonstrates the three crypto pieces the spike recommends, with no network
 * I/O and no new dependencies:
 *
 *  1. `deriveKeypairFromSeed` — the non-custodial (Phase 1) signing root: a
 *     WebAuthn/passkey-derived 32-byte seed becomes the CHW's Ed25519 Stellar
 *     key, so the private material stays on the device.
 *
 *  2. `signAddressOwnership` / `verifyAddressOwnership` — the enrollment
 *     binding proof. The enrollee signs a challenge (SEP-53) to prove they
 *     control the Stellar address, so an admin cannot silently bind a foreign
 *     address and redirect payouts.
 *
 *  3. `buildAndSignAttestTransaction` — the custodial (Phase 0) signing path:
 *     the verifier backend holds the per-CHW key and signs the Soroban
 *     `attest` invocation only after an authorized request.
 *
 * This module is deliberately import-safe: it never touches `serverEnv` or
 * Supabase, so it can be unit-tested without the full Next/request context.
 */

const SEED_LENGTH_BYTES = 32;

/**
 * Derive a Stellar keypair from a 32-byte seed (e.g. HKDF output from a
 * WebAuthn passkey credential). This is the Phase 1 non-custodial root: the
 * seed never leaves the device.
 */
export function deriveKeypairFromSeed(seed: Uint8Array): Keypair {
  if (seed.length !== SEED_LENGTH_BYTES) {
    throw new Error(
      `deriveKeypairFromSeed: seed must be ${SEED_LENGTH_BYTES} bytes, got ${seed.length}`,
    );
  }
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

/**
 * Deterministic enrollment challenge bound to the CHW's app identity and a
 * per-enrollment nonce (the nonce is what makes re-proofs fresh; the challenge
 * itself is not secret). Returns the UTF-8 challenge string the enrollee signs
 * via SEP-53 `signMessage`.
 */
export function createEnrollmentChallenge(
  chwUserId: string,
  nonce: string,
): string {
  const fingerprint = createHash("sha256")
    .update(`lafiya-chw-bind:${chwUserId}:${nonce}`)
    .digest("hex");
  return `Lafiya CHW enrollment — prove control of this Stellar address (challenge: ${fingerprint})`;
}

/**
 * Sign the enrollment challenge with the CHW's secret key, using SEP-53
 * message signing (the standard "prove you own this address" primitive).
 * Returns the 64-byte signature as hex.
 */
export function signAddressOwnership(
  secretKey: string,
  challenge: string,
): string {
  return Keypair.fromSecret(secretKey).signMessage(challenge).toString("hex");
}

/**
 * Verify an enrollment proof: the given signature must be a valid SEP-53
 * signature over the exact challenge, made by the claimed public key.
 */
export function verifyAddressOwnership(
  publicKey: string,
  challenge: string,
  signatureHex: string,
): boolean {
  return Keypair.fromPublicKey(publicKey).verifyMessage(
    challenge,
    Buffer.from(signatureHex, "hex"),
  );
}

export type AttestSigningParams = {
  /** Per-CHW custody key (server-side in Phase 0). Never leaves the server. */
  signerSecret: string;
  contractId: string;
  networkPassphrase: string;
  /** Hex record_hash produced by lib/attestation/recordHash.ts. */
  recordHashHex: string;
  /** The allowlisted Stellar address the attestation is attributed to. */
  attesterAddress: string;
  /** Unix seconds. */
  timestamp: number;
  /** Source account sequence. "0" is fine for a PoC that never submits. */
  sequence?: string;
};

export type SignedAttestTransaction = {
  /** Base64 XDR of the signed transaction envelope. */
  xdr: string;
  /** Public key of the signer (asserted in tests). */
  signerPublicKey: string;
};

/**
 * Phase 0 custodial path: build and sign the Soroban `attest` invocation with
 * the CHW's custody key. This only *builds and signs* — it never submits, so
 * it is safe to run offline and is what the verifier queues for later
 * submission when connectivity returns.
 *
 * The exact SCVal encodings mirror lib/stellar/attestation.ts and are
 * illustrative; the authoritative arg types live in lafiya-contracts.
 */
export function buildAndSignAttestTransaction(
  params: AttestSigningParams,
): SignedAttestTransaction {
  const signer = Keypair.fromSecret(params.signerSecret);
  const source = new Account(signer.publicKey(), params.sequence ?? "0");
  const contract = new Contract(params.contractId);

  const invocation = contract.call(
    "attest",
    nativeToScVal(Buffer.from(params.recordHashHex, "hex"), { type: "bytes" }),
    nativeToScVal(params.attesterAddress, { type: "address" }),
    nativeToScVal(BigInt(params.timestamp), { type: "u64" }),
  );

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: params.networkPassphrase,
  })
    .addOperation(invocation)
    .setTimeout(30)
    .build();

  tx.sign(signer);

  return { xdr: tx.toXDR(), signerPublicKey: signer.publicKey() };
}
