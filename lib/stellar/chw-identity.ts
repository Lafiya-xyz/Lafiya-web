import { createHash, randomBytes } from "node:crypto";

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
 *
 * The challenge is scoped to the organization the CHW is enrolling under so a
 * proof captured for one tenant cannot be replayed to bind the same address
 * under a different organization (issue #621 multi-tenant boundary).
 */
export function createEnrollmentChallenge(
  chwUserId: string,
  nonce: string,
  organizationId?: string,
): string {
  const scope = organizationId ? `:${organizationId}` : "";
  const fingerprint = createHash("sha256")
    .update(`lafiya-chw-bind:${chwUserId}:${nonce}${scope}`)
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
  // `signMessage` returns a plain Uint8Array (not a Node Buffer), so
  // `.toString("hex")` would produce a comma-separated decimal list instead
  // of hex — route it through Buffer.from to hex-encode explicitly.
  return Buffer.from(
    Keypair.fromSecret(secretKey).signMessage(challenge),
  ).toString("hex");
}

const HEX_SIGNATURE_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Verify an enrollment proof: the given signature must be a valid SEP-53
 * signature over the exact challenge, made by the claimed public key.
 */
export function verifyAddressOwnership(
  publicKey: string,
  challenge: string,
  signatureHex: string,
): boolean {
  // `Buffer.from(str, "hex")` silently drops invalid trailing characters
  // instead of throwing, which would let a malformed signature verify
  // against a truncated/empty buffer rather than failing loudly.
  if (
    signatureHex.length === 0 ||
    signatureHex.length % 2 !== 0 ||
    !HEX_SIGNATURE_PATTERN.test(signatureHex)
  ) {
    throw new Error(
      `verifyAddressOwnership: signatureHex is not valid hex: ${signatureHex}`,
    );
  }
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
  /**
   * Organization (facility/NGO) the attestation is attributed to. Scopes the
   * signed payload to a single tenant so an attestation cannot be replayed
   * across organizations (issue #621). Optional for backward compatibility
   * with the default organization.
   */
  organizationId?: string;
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

/**
 * SEP-10 web authentication primitives for CHW wallet sign-in (issue #556).
 *
 * A CHW proves control of their Stellar address by signing a server-issued
 * challenge transaction. These helpers build and verify that challenge
 * following SEP-10 exactly (home domain, `web_auth_domain`, timebounds, and
 * nonce replay protection) so the API routes in `app/api/sep10/` stay thin.
 *
 * Like the rest of this module, it is import-safe: no `serverEnv`, no
 * Supabase, no network I/O — the signing key is passed in by the caller.
 */

/** SEP-10 challenge transactions are valid for a short window. */
export const SEP10_CHALLENGE_TTL_SECONDS = 300;

/** SEP-10 requires the challenge to be signed by the server signing key. */
export type Sep10ChallengeParams = {
  /** Server signing key (secret) held in server env, validated at boot. */
  serverSigningSecret: string;
  /** The CHW's Stellar account (G...) requesting authentication. */
  account: string;
  /** Home domain of the service issuing the challenge. */
  homeDomain: string;
  /** Host serving the SEP-10 endpoints (the `web_auth_domain`). */
  webAuthDomain: string;
  /** Stellar network passphrase the challenge is bound to. */
  networkPassphrase: string;
  /** Unix seconds; defaults to now. */
  now?: number;
};

export type Sep10Challenge = {
  /** Base64 XDR of the signed challenge transaction. */
  transaction: string;
  /** The random nonce embedded in the challenge (for replay tracking). */
  nonce: string;
  /** Unix seconds the challenge expires. */
  expiresAt: number;
};

/**
 * Build and sign a SEP-10 challenge transaction for `account`.
 *
 * The transaction has a single `manageData` operation whose name is
 * `<homeDomain> auth` and whose value is a random 48-byte nonce, with
 * timebounds `[now, now + TTL]`. The server signing key signs it, and the
 * `web_auth_domain` is recorded in the transaction memo so the client can
 * confirm it is talking to the right host.
 */
export function buildSep10Challenge(params: Sep10ChallengeParams): Sep10Challenge {
  const serverKeypair = Keypair.fromSecret(params.serverSigningSecret);
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + SEP10_CHALLENGE_TTL_SECONDS;
  const nonce = randomBytes(48).toString("base64");

  const source = new Account(params.account, "0");
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: params.networkPassphrase,
    timebounds: { minTime: now, maxTime: expiresAt },
  })
    .addOperation(
      // SEP-10: manageData name is `<home_domain> auth`, value is the nonce.
      // The SDK's Operation.manageData is reached via the builder below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      (require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk")).Operation.manageData({
        name: `${params.homeDomain} auth`,
        value: nonce,
      }),
    )
    .addMemo(
      // SEP-10: memo is the `web_auth_domain` (text memo, <= 28 bytes).
      (require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk")).Memo.text(
        params.webAuthDomain,
      ),
    )
    .build();

  tx.sign(serverKeypair);

  return { transaction: tx.toXDR(), nonce, expiresAt };
}

export type Sep10VerificationResult = {
  /** The CHW account that signed the challenge. */
  account: string;
  /** The nonce from the challenge, for replay tracking. */
  nonce: string;
};

/**
 * Verify a signed SEP-10 challenge transaction.
 *
 * Checks that the transaction is signed by both the server signing key and
 * the claimed `account`, that it is still within its timebounds, and that the
 * `manageData` name matches `<homeDomain> auth`. The caller is responsible
 * for rejecting a `nonce` it has already seen (replay protection).
 */
export function verifySep10Challenge(
  params: Sep10ChallengeParams & { transaction: string },
): Sep10VerificationResult {
  const sdk = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
  const serverKeypair = Keypair.fromSecret(params.serverSigningSecret);
  const now = params.now ?? Math.floor(Date.now() / 1000);

  const tx = new sdk.Transaction(params.transaction, params.networkPassphrase);

  // Timebounds: reject expired or not-yet-valid challenges.
  if (tx.timeBounds) {
    const minTime = Number(tx.timeBounds.minTime);
    const maxTime = Number(tx.timeBounds.maxTime);
    if (now < minTime || now > maxTime) {
      throw new Error("verifySep10Challenge: challenge is outside its timebounds");
    }
  }

  // The server signing key must have signed the challenge.
  const serverSigned = tx.signatures.some((sig) => {
    try {
      return serverKeypair.verify(tx.hash(), sig.signature());
    } catch {
      return false;
    }
  });
  if (!serverSigned) {
    throw new Error("verifySep10Challenge: missing server signing key signature");
  }

  // The claimed account must have signed the challenge.
  const accountKeypair = Keypair.fromPublicKey(params.account);
  const accountSigned = tx.signatures.some((sig) => {
    try {
      return accountKeypair.verify(tx.hash(), sig.signature());
    } catch {
      return false;
    }
  });
  if (!accountSigned) {
    throw new Error("verifySep10Challenge: missing account signature");
  }

  // The manageData operation must be `<homeDomain> auth` and carry a nonce.
  const op = tx.operations[0];
  if (!op || op.type !== "manageData") {
    throw new Error("verifySep10Challenge: expected a manageData operation");
  }
  if (op.name !== `${params.homeDomain} auth") {
    throw new Error("verifySep10Challenge: manageData name does not match home domain");
  }
  const nonce = op.value ? Buffer.from(op.value).toString("base64") : "";
  if (!nonce) {
    throw new Error("verifySep10Challenge: challenge is missing a nonce");
  }

  return { account: params.account, nonce };
}
