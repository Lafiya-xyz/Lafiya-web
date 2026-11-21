import { createHash } from "node:crypto";

import { StrKey } from "@stellar/stellar-sdk";

/**
 * Spike PoC — passkey (secp256r1) smart-wallet primitives for CHWs
 * (see docs/adr-006-passkey-smart-wallets.md; issue #903).
 *
 * A Soroban *custom account* contract verifies WebAuthn assertions itself, so
 * the CHW's signing root is a P-256 passkey held by the platform authenticator
 * instead of an Ed25519 secret key. This module implements the off-chain half
 * of that design with no network I/O and no new dependencies:
 *
 *  1. `parseAuthenticatorData` / `parseCoseP256PublicKey` — decode the
 *     WebAuthn registration response into the raw 64-byte uncompressed P-256
 *     public key the contract stores.
 *  2. `buildWebAuthnSignedPayload` — the exact byte string the passkey signs
 *     for a Soroban invocation (`authenticatorData || sha256(clientDataJSON)`),
 *     domain-separated by network and contract so an assertion cannot be
 *     replayed on another network or account.
 *  3. `buildSecp256r1SignatureScVal` — encode the assertion as the
 *     `(signature, public_key)` ScVal pair the custom account's `__check_auth`
 *     expects.
 *  4. `deriveSmartWalletAddress` — the deterministic contract address for a
 *     given passkey + salt, so enrollment can be idempotent.
 *
 * Deliberately import-safe: no `serverEnv`, no Supabase, no RPC.
 */

const P256_UNCOMPRESSED_LENGTH = 65;
const P256_COORDINATE_LENGTH = 32;
const AUTHENTICATOR_DATA_MIN_LENGTH = 37;
const COSE_ALG_ES256 = -7;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

/** WebAuthn flags (byte 32 of authenticator data). */
export const AUTHENTICATOR_FLAG_UP = 0x01;
export const AUTHENTICATOR_FLAG_UV = 0x04;
export const AUTHENTICATOR_FLAG_AT = 0x40;

export type ParsedAuthenticatorData = {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  /** Present only when the AT flag is set (registration). */
  credentialId?: Buffer;
  /** Raw 65-byte uncompressed P-256 key, present only when AT is set. */
  publicKey?: Buffer;
};

/**
 * Decode WebAuthn authenticator data. Registration responses carry the
 * credential id and COSE public key; assertion responses stop after the
 * signature counter.
 */
export function parseAuthenticatorData(
  authenticatorData: Uint8Array,
): ParsedAuthenticatorData {
  const data = Buffer.from(authenticatorData);
  if (data.length < AUTHENTICATOR_DATA_MIN_LENGTH) {
    throw new Error(
      `parseAuthenticatorData: expected at least ${AUTHENTICATOR_DATA_MIN_LENGTH} bytes, got ${data.length}`,
    );
  }
  const rpIdHash = data.subarray(0, 32);
  const flags = data[32];
  const signCount = data.readUInt32BE(33);
  const parsed: ParsedAuthenticatorData = { rpIdHash, flags, signCount };

  if ((flags & AUTHENTICATOR_FLAG_AT) === 0) {
    return parsed;
  }

  // attestedCredentialData: aaguid(16) || credIdLen(2) || credId || COSE key
  let offset = AUTHENTICATOR_DATA_MIN_LENGTH + 16;
  if (data.length < offset + 2) {
    throw new Error("parseAuthenticatorData: truncated attested credential data");
  }
  const credentialIdLength = data.readUInt16BE(offset);
  offset += 2;
  if (data.length < offset + credentialIdLength) {
    throw new Error("parseAuthenticatorData: truncated credential id");
  }
  parsed.credentialId = data.subarray(offset, offset + credentialIdLength);
  offset += credentialIdLength;
  parsed.publicKey = parseCoseP256PublicKey(data.subarray(offset));
  return parsed;
}

/**
 * Decode a COSE_Key (CBOR map) for an ES256/P-256 credential into the raw
 * uncompressed SEC1 point (`0x04 || x || y`) that Soroban's secp256r1 host
 * functions accept. Only the fixed-shape subset WebAuthn emits is supported.
 */
export function parseCoseP256PublicKey(coseKey: Uint8Array): Buffer {
  const bytes = Buffer.from(coseKey);
  const entries = readCborMap(bytes);
  const kty = entries.get(1);
  const alg = entries.get(3);
  const crv = entries.get(-1);
  const x = entries.get(-2);
  const y = entries.get(-3);

  if (kty !== COSE_KTY_EC2 || alg !== COSE_ALG_ES256 || crv !== COSE_CRV_P256) {
    throw new Error(
      "parseCoseP256PublicKey: credential is not an ES256/P-256 COSE key",
    );
  }
  if (
    !Buffer.isBuffer(x) ||
    !Buffer.isBuffer(y) ||
    x.length !== P256_COORDINATE_LENGTH ||
    y.length !== P256_COORDINATE_LENGTH
  ) {
    throw new Error(
      "parseCoseP256PublicKey: x/y must be 32-byte P-256 coordinates",
    );
  }
  return Buffer.concat([Buffer.from([0x04]), x, y]);
}

/**
 * Minimal CBOR map reader for COSE keys: integer keys, byte-string and
 * integer values. Rejects anything else rather than guessing.
 */
function readCborMap(bytes: Buffer): Map<number, number | Buffer> {
  const entries = new Map<number, number | Buffer>();
  let offset = 0;

  const readLength = (additional: number): number => {
    if (additional < 24) return additional;
    if (additional === 24) {
      const value = bytes[offset];
      offset += 1;
      return value;
    }
    if (additional === 25) {
      const value = bytes.readUInt16BE(offset);
      offset += 2;
      return value;
    }
    throw new Error("readCborMap: unsupported CBOR length encoding");
  };

  const readItem = (): number | Buffer => {
    if (offset >= bytes.length) {
      throw new Error("readCborMap: truncated CBOR item");
    }
    const initial = bytes[offset];
    offset += 1;
    const major = initial >> 5;
    const additional = initial & 0x1f;

    if (major === 0) return readLength(additional);
    if (major === 1) return -1 - readLength(additional);
    if (major === 2) {
      const length = readLength(additional);
      if (offset + length > bytes.length) {
        throw new Error("readCborMap: truncated byte string");
      }
      const value = bytes.subarray(offset, offset + length);
      offset += length;
      return value;
    }
    throw new Error(`readCborMap: unsupported CBOR major type ${major}`);
  };

  if (bytes.length === 0 || bytes[0] >> 5 !== 5) {
    throw new Error("readCborMap: expected a CBOR map");
  }
  offset = 1;
  const count = readLength(bytes[0] & 0x1f);
  for (let i = 0; i < count; i += 1) {
    const key = readItem();
    if (typeof key !== "number") {
      throw new Error("readCborMap: only integer keys are supported");
    }
    entries.set(key, readItem());
  }
  return entries;
}

export type WebAuthnSignedPayloadParams = {
  /** Raw authenticator data from the assertion. */
  authenticatorData: Uint8Array;
  /** The `clientDataJSON` bytes exactly as the authenticator hashed them. */
  clientDataJSON: Uint8Array;
  /** Stellar network passphrase — binds the assertion to one network. */
  networkPassphrase: string;
  /** Custom account contract id (C...). */
  contractId: string;
  /** Hex-encoded 32-byte invocation payload hash (e.g. the attest args hash). */
  payloadHashHex: string;
};

/**
 * Build the byte string a passkey signs for a Soroban invocation:
 * `authenticatorData || sha256(clientDataJSON)`. The caller sets
 * `PublicKeyCredentialRequestOptions.challenge` to `createWalletChallenge(...)`
 * so the network, contract, and payload are bound into the signed bytes; the
 * contract then verifies the result with `secp256r1_verify` and no extra
 * hashing.
 */
export function buildWebAuthnSignedPayload(
  params: WebAuthnSignedPayloadParams,
): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(params.payloadHashHex)) {
    throw new Error(
      "buildWebAuthnSignedPayload: payloadHashHex must be 32 bytes of hex",
    );
  }
  if (!StrKey.isValidContract(params.contractId)) {
    throw new Error(
      "buildWebAuthnSignedPayload: contractId must be a valid contract address",
    );
  }
  const clientDataHash = createHash("sha256")
    .update(Buffer.from(params.clientDataJSON))
    .digest();
  return Buffer.concat([Buffer.from(params.authenticatorData), clientDataHash]);
}

/**
 * The WebAuthn challenge for a smart-wallet invocation. Deterministic in the
 * payload, network, and contract, so a captured assertion cannot be replayed
 * against a different invocation, network, or account.
 */
export function createWalletChallenge(
  params: Omit<
    WebAuthnSignedPayloadParams,
    "authenticatorData" | "clientDataJSON"
  >,
): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(params.payloadHashHex)) {
    throw new Error(
      "createWalletChallenge: payloadHashHex must be 32 bytes of hex",
    );
  }
  if (!StrKey.isValidContract(params.contractId)) {
    throw new Error(
      "createWalletChallenge: contractId must be a valid contract address",
    );
  }
  return createHash("sha256")
    .update("lafiya-passkey-wallet-v1:")
    .update(params.networkPassphrase)
    .update(":")
    .update(params.contractId)
    .update(":")
    .update(Buffer.from(params.payloadHashHex, "hex"))
    .digest();
}

export type Secp256r1SignatureScVal = {
  /** 64-byte `r || s` signature, hex. */
  signature: string;
  /** 65-byte uncompressed public key, hex. */
  publicKey: string;
};

/**
 * Encode a WebAuthn assertion as the `(signature, public_key)` pair the
 * custom account's `__check_auth` receives. DER-encoded ECDSA signatures are
 * rejected: Soroban's `secp256r1_verify` takes raw `r || s`.
 */
export function buildSecp256r1SignatureScVal(
  signature: Uint8Array,
  publicKey: Uint8Array,
): Secp256r1SignatureScVal {
  const sig = Buffer.from(signature);
  const key = Buffer.from(publicKey);
  if (sig.length !== 64) {
    throw new Error(
      `buildSecp256r1SignatureScVal: signature must be 64 bytes (r||s), got ${sig.length}`,
    );
  }
  if (key.length !== P256_UNCOMPRESSED_LENGTH || key[0] !== 0x04) {
    throw new Error(
      "buildSecp256r1SignatureScVal: public key must be a 65-byte uncompressed point",
    );
  }
  return { signature: sig.toString("hex"), publicKey: key.toString("hex") };
}

/**
 * Deterministic smart-wallet contract address for a passkey + salt. Mirrors
 * the `deployer().with_address(salt, ...)` convention so re-enrolling the same
 * passkey under the same salt is idempotent instead of creating a second
 * account that would need a second allowlist entry.
 */
export function deriveSmartWalletAddress(
  publicKey: Uint8Array,
  salt: Uint8Array,
): string {
  const key = Buffer.from(publicKey);
  if (key.length !== P256_UNCOMPRESSED_LENGTH || key[0] !== 0x04) {
    throw new Error(
      "deriveSmartWalletAddress: public key must be a 65-byte uncompressed point",
    );
  }
  if (salt.length === 0) {
    throw new Error("deriveSmartWalletAddress: salt must not be empty");
  }
  const digest = createHash("sha256")
    .update("lafiya-passkey-wallet-address-v1:")
    .update(key)
    .update(":")
    .update(Buffer.from(salt))
    .digest();
  return StrKey.encodeContract(digest);
}
