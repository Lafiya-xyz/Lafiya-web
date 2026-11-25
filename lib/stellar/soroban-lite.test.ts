// @vitest-environment node
import {
  Address,
  Keypair,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

// Keep this test independent of server env / runtime config loading.
vi.mock("@/lib/env-server", () => ({ serverEnv: {} }));
vi.mock("@/lib/chw-protocol/config", () => ({
  getProtocolRuntimeConfig: () => ({}),
}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));

import { decodeAttestation } from "./attestation";
import { buildInvokeContractEnvelope, decodeScVal } from "./soroban-lite";

// Differential tests (Issue #880): the minimal codec must agree with the SDK.

const FIXTURE_COUNT = 128;

function randomBytes(n: number): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(n)));
}

function attestationFixture(i: number): xdr.ScVal {
  const attester =
    i % 3 === 0
      ? StrKey.encodeContract(randomBytes(32))
      : Keypair.random().publicKey();
  const entries: [string, xdr.ScVal][] = [
    ["attester", new Address(attester).toScVal()],
    [
      "expiry",
      i % 2
        ? nativeToScVal(BigInt(1_700_000_000 + i), { type: "u64" })
        : xdr.ScVal.scvVoid(),
    ],
    ["record_hash", nativeToScVal(randomBytes(32))],
    ["revoked", i % 4 ? xdr.ScVal.scvBool(i % 4 === 1) : xdr.ScVal.scvVoid()],
    [
      "timestamp",
      nativeToScVal(BigInt(1_735_689_600 + i * 97), { type: "u64" }),
    ],
  ];
  return xdr.ScVal.scvMap(
    entries.map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
    ),
  );
}

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  }
  return value === null ? undefined : value;
}

describe("soroban-lite decodeScVal", () => {
  it(`matches scValToNative across ${FIXTURE_COUNT} attestation fixtures`, () => {
    for (let i = 0; i < FIXTURE_COUNT; i += 1) {
      const scVal = attestationFixture(i);
      const ours = decodeScVal(scVal.toXDR("base64"));
      expect(normalize(ours)).toEqual(normalize(scValToNative(scVal)));

      const decoded = decodeAttestation(ours, "unused");
      const sdk = scValToNative(scVal) as Record<string, unknown>;
      expect(decoded).toMatchObject({
        attester: sdk.attester,
        recordHash: Buffer.from(sdk.record_hash as Buffer).toString("hex"),
        timestamp: Number(sdk.timestamp),
      });
    }
  });

  it("matches scValToNative for scalar and container types", () => {
    const values = [
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvBool(true),
      nativeToScVal(42, { type: "u32" }),
      nativeToScVal(-42, { type: "i32" }),
      nativeToScVal(-BigInt(5), { type: "i64" }),
      nativeToScVal(BigInt(2) ** BigInt(100), { type: "u128" }),
      nativeToScVal(-(BigInt(2) ** BigInt(100)), { type: "i128" }),
      nativeToScVal(BigInt(2) ** BigInt(200), { type: "u256" }),
      nativeToScVal(-(BigInt(2) ** BigInt(200)), { type: "i256" }),
      nativeToScVal("héllo", { type: "string" }),
      nativeToScVal("sym", { type: "symbol" }),
      nativeToScVal([1, 2, 3].map((n) => nativeToScVal(n, { type: "u32" }))),
    ];
    for (const value of values) {
      expect(normalize(decodeScVal(value.toXDR("base64")))).toEqual(
        normalize(scValToNative(value)),
      );
    }
  });
});

describe("soroban-lite buildInvokeContractEnvelope", () => {
  it("produces an envelope the SDK parses as get_attestation(recordHash)", () => {
    const contractId = StrKey.encodeContract(randomBytes(32));
    const recordHash = "b".repeat(64);
    const envelope = buildInvokeContractEnvelope(
      contractId,
      "get_attestation",
      [recordHash],
    );

    const tx = TransactionBuilder.fromXDR(
      envelope,
      "Test SDF Network ; September 2015",
    );
    expect("operations" in tx).toBe(true);
    const op = (
      tx as unknown as {
        operations: Array<{ type: string; func: xdr.HostFunction }>;
      }
    ).operations[0];
    expect(op.type).toBe("invokeHostFunction");
    const args = op.func.value as unknown as xdr.InvokeContractArgs;
    expect(Address.fromScAddress(args.contractAddress).toString()).toBe(
      contractId,
    );
    expect(args.functionName.toString()).toBe("get_attestation");
    expect(args.args.map((a: xdr.ScVal) => scValToNative(a))).toEqual([
      recordHash,
    ]);
  });
});
