// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { StrKey } from "@stellar/stellar-sdk";

import {
  AUTHENTICATOR_FLAG_AT,
  AUTHENTICATOR_FLAG_UP,
  AUTHENTICATOR_FLAG_UV,
  buildSecp256r1SignatureScVal,
  buildWebAuthnSignedPayload,
  createWalletChallenge,
  deriveSmartWalletAddress,
  parseAuthenticatorData,
  parseCoseP256PublicKey,
} from "@/lib/stellar/passkey-wallet";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 3));
const NETWORK = "Test SDF Network ; September 2015";
const PAYLOAD_HASH = "b".repeat(64);

/** Build a COSE_Key CBOR map for an ES256/P-256 credential. */
function coseP256Key(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa5]), // map(5)
    Buffer.from([0x01, 0x02]), // 1: 2 (kty EC2)
    Buffer.from([0x03, 0x26]), // 3: -7 (alg ES256)
    Buffer.from([0x20, 0x01]), // -1: 1 (crv P-256)
    Buffer.from([0x21, 0x58, 0x20]), // -2: bytes(32)
    x,
    Buffer.from([0x22, 0x58, 0x20]), // -3: bytes(32)
    y,
  ]);
}

function authenticatorData(flags: number, coseKey?: Buffer): Buffer {
  const head = Buffer.alloc(37);
  Buffer.alloc(32, 9).copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(7, 33);
  if (!coseKey) return head;
  const credentialId = Buffer.alloc(16, 4);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length, 0);
  return Buffer.concat([
    head,
    Buffer.alloc(16, 0), // aaguid
    length,
    credentialId,
    coseKey,
  ]);
}

describe("parseAuthenticatorData", () => {
  const x = Buffer.alloc(32, 1);
  const y = Buffer.alloc(32, 2);

  it("extracts the credential id and uncompressed P-256 key on registration", () => {
    const parsed = parseAuthenticatorData(
      authenticatorData(
        AUTHENTICATOR_FLAG_UP | AUTHENTICATOR_FLAG_UV | AUTHENTICATOR_FLAG_AT,
        coseP256Key(x, y),
      ),
    );
    expect(parsed.signCount).toBe(7);
    expect(parsed.credentialId).toHaveLength(16);
    expect(parsed.publicKey).toEqual(Buffer.concat([Buffer.from([0x04]), x, y]));
  });

  it("returns no key for an assertion (AT flag clear)", () => {
    const parsed = parseAuthenticatorData(
      authenticatorData(AUTHENTICATOR_FLAG_UP | AUTHENTICATOR_FLAG_UV),
    );
    expect(parsed.publicKey).toBeUndefined();
  });

  it("rejects truncated authenticator data", () => {
    expect(() => parseAuthenticatorData(Buffer.alloc(10))).toThrow(
      /at least 37 bytes/,
    );
  });
});

describe("parseCoseP256PublicKey", () => {
  it("rejects a non-P-256 COSE key", () => {
    expect(() =>
      parseCoseP256PublicKey(Buffer.from([0xa1, 0x01, 0x01])),
    ).toThrow(/not an ES256\/P-256/);
  });
});

describe("wallet challenge and signed payload", () => {
  it("binds network, contract, and payload into the challenge", () => {
    const base = {
      networkPassphrase: NETWORK,
      contractId: CONTRACT_ID,
      payloadHashHex: PAYLOAD_HASH,
    };
    const challenge = createWalletChallenge(base);
    expect(challenge).toHaveLength(32);
    expect(
      createWalletChallenge({
        ...base,
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    ).not.toEqual(challenge);
    expect(
      createWalletChallenge({ ...base, payloadHashHex: "c".repeat(64) }),
    ).not.toEqual(challenge);
  });

  it("rejects a malformed payload hash or contract id", () => {
    expect(() =>
      createWalletChallenge({
        networkPassphrase: NETWORK,
        contractId: CONTRACT_ID,
        payloadHashHex: "abc",
      }),
    ).toThrow(/32 bytes of hex/);
    expect(() =>
      createWalletChallenge({
        networkPassphrase: NETWORK,
        contractId: "GABC",
        payloadHashHex: PAYLOAD_HASH,
      }),
    ).toThrow(/valid contract address/);
  });

  it("assembles authenticatorData || sha256(clientDataJSON)", () => {
    const authData = authenticatorData(AUTHENTICATOR_FLAG_UP);
    const clientDataJSON = Buffer.from('{"type":"webauthn.get"}');
    const payload = buildWebAuthnSignedPayload({
      authenticatorData: authData,
      clientDataJSON,
      networkPassphrase: NETWORK,
      contractId: CONTRACT_ID,
      payloadHashHex: PAYLOAD_HASH,
    });
    expect(payload).toEqual(
      Buffer.concat([
        authData,
        createHash("sha256").update(clientDataJSON).digest(),
      ]),
    );
  });
});

describe("buildSecp256r1SignatureScVal", () => {
  it("hex-encodes a raw r||s signature and uncompressed key", () => {
    const encoded = buildSecp256r1SignatureScVal(
      Buffer.alloc(64, 5),
      Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 6)]),
    );
    expect(encoded.signature).toBe("05".repeat(64));
    expect(encoded.publicKey).toBe(`04${"06".repeat(64)}`);
  });

  it("rejects DER-length signatures", () => {
    expect(() =>
      buildSecp256r1SignatureScVal(
        Buffer.alloc(70, 5),
        Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 6)]),
      ),
    ).toThrow(/64 bytes/);
  });
});

describe("deriveSmartWalletAddress", () => {
  const publicKey = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]);

  it("is deterministic and a valid contract address", () => {
    const address = deriveSmartWalletAddress(publicKey, Buffer.from("chw-1"));
    expect(StrKey.isValidContract(address)).toBe(true);
    expect(deriveSmartWalletAddress(publicKey, Buffer.from("chw-1"))).toBe(
      address,
    );
  });

  it("differs per salt and per passkey", () => {
    const address = deriveSmartWalletAddress(publicKey, Buffer.from("chw-1"));
    expect(deriveSmartWalletAddress(publicKey, Buffer.from("chw-2"))).not.toBe(
      address,
    );
    expect(
      deriveSmartWalletAddress(
        Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 8)]),
        Buffer.from("chw-1"),
      ),
    ).not.toBe(address);
  });

  it("rejects a compressed or empty input", () => {
    expect(() =>
      deriveSmartWalletAddress(Buffer.alloc(33, 2), Buffer.from("chw-1")),
    ).toThrow(/65-byte uncompressed/);
    expect(() => deriveSmartWalletAddress(publicKey, Buffer.alloc(0))).toThrow(
      /salt must not be empty/,
    );
  });
});
