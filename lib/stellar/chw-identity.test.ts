// @vitest-environment node
// (the real @stellar/stellar-sdk exercises @noble/ed25519, whose byte-type
// check rejects Node Buffers under the jsdom realm; this test needs no DOM)
import { describe, expect, it } from "vitest";

import {
  Keypair,
  StrKey,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";

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
    });

    expect(signerPublicKey).toBe(signer.publicKey());
    // Non-empty, base64-encoded XDR envelope.
    expect(xdr.length).toBeGreaterThan(0);
    expect(() => Buffer.from(xdr, "base64").toString("base64")).not.toThrow();

    const transaction = TransactionBuilder.fromXDR(
      xdr,
      "Test SDF Network ; September 2015",
    );
    const operation = transaction.operations[0];
    expect(operation.type).toBe("invokeHostFunction");
    if (operation.type !== "invokeHostFunction") return;
    const invocation = operation.func.invokeContract();
    expect(invocation.functionName().toString()).toBe("attest");
    expect(invocation.args()).toHaveLength(2);
    expect(scValToNative(invocation.args()[0])).toBe(signer.publicKey());
    expect(
      Buffer.from(scValToNative(invocation.args()[1]) as Buffer).toString(
        "hex",
      ),
    ).toBe("a".repeat(64));
  });
});
