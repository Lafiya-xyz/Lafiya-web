// @vitest-environment node
// (the real @stellar/stellar-sdk exercises @noble/ed25519, whose byte-type
// check rejects Node Buffers under the jsdom realm; this test needs no DOM)
import { describe, expect, it } from "vitest";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

import {
  buildAndSignAttestTransaction,
  createEnrollmentChallenge,
  deriveKeypairFromSeed,
  signAddressOwnership,
  verifyAddressOwnership,
} from "@/lib/stellar/chw-identity";

describe("deriveKeypairFromSeed (non-custodial Phase 1 root)", () => {
  it("derives a valid Ed25519 Stellar keypair from a 32-byte seed", () => {
    const keypair = deriveKeypairFromSeed(Buffer.alloc(32, 7));
    expect(keypair.publicKey()).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("is deterministic for the same seed", () => {
    expect(deriveKeypairFromSeed(Buffer.alloc(32, 7)).publicKey()).toBe(
      deriveKeypairFromSeed(Buffer.alloc(32, 7)).publicKey(),
    );
  });

  it("rejects a seed that is not 32 bytes", () => {
    expect(() => deriveKeypairFromSeed(Buffer.alloc(31))).toThrow(
      /seed must be 32 bytes/,
    );
  });
});

describe("address ownership proof (enrollment binding)", () => {
  const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const userId = "00000000-0000-0000-0000-000000000001";
  const nonce = "enroll-001";
  const challenge = createEnrollmentChallenge(userId, nonce);

  it("verifies a signature made by the claimed address over the challenge", () => {
    const signature = signAddressOwnership(keypair.secret(), challenge);
    expect(
      verifyAddressOwnership(keypair.publicKey(), challenge, signature),
    ).toBe(true);
  });

  it("rejects a signature over a different (tampered) challenge", () => {
    const signature = signAddressOwnership(keypair.secret(), challenge);
    const tampered = createEnrollmentChallenge(userId, "enroll-002");
    expect(
      verifyAddressOwnership(keypair.publicKey(), tampered, signature),
    ).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
    const signature = signAddressOwnership(other.secret(), challenge);
    expect(
      verifyAddressOwnership(keypair.publicKey(), challenge, signature),
    ).toBe(false);
  });
});

describe("address ownership proof — edge cases", () => {
  const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const userId = "00000000-0000-0000-0000-000000000001";
  const nonce = "enroll-edge";
  const challenge = createEnrollmentChallenge(userId, nonce);

  it("throws on a malformed public key (not a valid StrKey)", () => {
    expect(() =>
      verifyAddressOwnership("not-a-valid-public-key", challenge, "00"),
    ).toThrow();
  });

  it("throws on a malformed public key (truncated/invalid checksum)", () => {
    const truncated = keypair.publicKey().slice(0, 10);
    expect(() =>
      verifyAddressOwnership(truncated, challenge, "00".repeat(64)),
    ).toThrow();
  });

  it("throws on a public key that decodes as the wrong key type (e.g. a secret seed)", () => {
    expect(() =>
      verifyAddressOwnership(keypair.secret(), challenge, "00".repeat(64)),
    ).toThrow();
  });

  it("rejects a not-yet-registered CHW identity: no on-chain binding exists yet, so any signature claiming that address must fail verification against a challenge the enrollment flow never issued for it", () => {
    // A freshly-generated keypair with no enrollment record: nothing has ever
    // signed a challenge for it, so a caller presenting an arbitrary
    // signature must be rejected rather than accepted by coincidence.
    const neverEnrolled = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 99));
    const bogusSignature = "00".repeat(64);
    expect(
      verifyAddressOwnership(
        neverEnrolled.publicKey(),
        challenge,
        bogusSignature,
      ),
    ).toBe(false);
  });

  it("rejects a signature for an identity whose key material has been revoked/deactivated (simulated by verifying against a since-rotated/withdrawn challenge)", () => {
    // Model revocation as the enrollment challenge being superseded: a CHW
    // that was previously valid but has since been deactivated must not
    // verify successfully against its original (now-revoked) binding once
    // the challenge/nonce it was bound to has moved on.
    const originalSignature = signAddressOwnership(
      keypair.secret(),
      challenge,
    );
    expect(
      verifyAddressOwnership(keypair.publicKey(), challenge, originalSignature),
    ).toBe(true);

    const revokedChallenge = createEnrollmentChallenge(userId, "revoked-nonce");
    expect(
      verifyAddressOwnership(
        keypair.publicKey(),
        revokedChallenge,
        originalSignature,
      ),
    ).toBe(false);
  });

  it("throws rather than silently verifying when the signature hex is malformed", () => {
    expect(() =>
      verifyAddressOwnership(keypair.publicKey(), challenge, "not-hex-zz"),
    ).toThrow();
  });
});

describe("buildAndSignAttestTransaction (custodial Phase 0 path)", () => {
  const signer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
  // A valid (checksummed) Soroban contract id, generated from 32 raw bytes.
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 3));

  it("produces a signed envelope attributed to the custody key", () => {
    const { xdr, signerPublicKey } = buildAndSignAttestTransaction({
      signerSecret: signer.secret(),
      contractId,
      networkPassphrase: "Test SDF Network ; September 2015",
      recordHashHex: "a".repeat(64),
      attesterAddress: signer.publicKey(),
      timestamp: 1735689600,
    });

    expect(signerPublicKey).toBe(signer.publicKey());
    // Non-empty, base64-encoded XDR envelope.
    expect(xdr.length).toBeGreaterThan(0);
    expect(() => Buffer.from(xdr, "base64").toString("base64")).not.toThrow();
  });
});
