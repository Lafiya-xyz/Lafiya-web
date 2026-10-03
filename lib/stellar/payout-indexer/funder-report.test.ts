import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildFunderReport,
  canonicalReportBytes,
  serializeReportCsv,
  serializeReportJson,
  type RawSettlementRecord,
} from "./funder-report";
import { signReportBytes, verifyReportSignature } from "./report-signing";

const FIXED_RECORDS: RawSettlementRecord[] = [
  { region: "Lagos", chwVerified: true, payoutAmountUsdc: "12.5000000", transactionHash: "hash-b" },
  { region: "Kano", chwVerified: true, payoutAmountUsdc: "7.2500000", transactionHash: "hash-a" },
  { region: "Lagos", chwVerified: true, payoutAmountUsdc: "10.0000000", transactionHash: "hash-a" },
  { region: "Lagos", chwVerified: false, payoutAmountUsdc: "0", transactionHash: null },
];

describe("buildFunderReport determinism (golden file)", () => {
  it("produces byte-identical canonical output for the same fixed dataset regardless of input order", () => {
    const reportA = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));
    const shuffled = [FIXED_RECORDS[3], FIXED_RECORDS[1], FIXED_RECORDS[0], FIXED_RECORDS[2]];
    const reportB = buildFunderReport("2026-09", shuffled, new Date("2026-10-01T12:34:56Z"));

    // generatedAt differs, but canonical (signed) bytes must be identical.
    expect(canonicalReportBytes(reportA).toString("utf8")).toBe(
      canonicalReportBytes(reportB).toString("utf8"),
    );
  });

  it("matches the expected golden JSON shape for the fixed dataset", () => {
    const report = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));

    expect(report.rows).toEqual([
      {
        region: "Kano",
        verifiedRegistrations: 1,
        payoutsCount: 1,
        payoutsTotalUsdc: "7.2500000",
        transactionHashes: ["hash-a"],
      },
      {
        region: "Lagos",
        verifiedRegistrations: 2,
        payoutsCount: 2,
        payoutsTotalUsdc: "22.5000000",
        transactionHashes: ["hash-a", "hash-b"],
      },
    ]);
  });

  it("produces stable region ordering regardless of insertion order", () => {
    const reversed = [...FIXED_RECORDS].reverse();
    const report = buildFunderReport("2026-09", reversed, new Date("2026-10-01T00:00:00Z"));
    expect(report.rows.map((r) => r.region)).toEqual(["Kano", "Lagos"]);
  });

  it("rejects a non-UTC-month period string", () => {
    expect(() => buildFunderReport("Sept 2026", [], new Date())).toThrow();
  });

  it("CSV serialization is deterministic for the fixed dataset", () => {
    const report = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));
    const csv = serializeReportCsv(report);
    expect(csv).toBe(
      "region,verified_registrations,payouts_count,payouts_total_usdc,transaction_hashes\n" +
        "Kano,1,1,7.2500000,\"hash-a\"\n" +
        "Lagos,2,2,22.5000000,\"hash-a;hash-b\"\n",
    );
  });
});

describe("sign-and-verify round trip", () => {
  it("verifies a signature produced by the signing keypair against its public key", () => {
    const report = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));
    const bytes = canonicalReportBytes(report);
    const signingKeypair = Keypair.random();

    const signed = signReportBytes(bytes, signingKeypair);

    expect(verifyReportSignature(bytes, signed.signature, signed.signerPublicKey)).toBe(true);
    expect(signed.signerPublicKey).toBe(signingKeypair.publicKey());
  });

  it("rejects a signature if the report bytes are tampered with after signing", () => {
    const report = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));
    const bytes = canonicalReportBytes(report);
    const signingKeypair = Keypair.random();
    const signed = signReportBytes(bytes, signingKeypair);

    const tampered = Buffer.concat([bytes, Buffer.from("tampered")]);
    expect(verifyReportSignature(tampered, signed.signature, signed.signerPublicKey)).toBe(false);
  });

  it("rejects a signature verified against the wrong public key", () => {
    const report = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));
    const bytes = canonicalReportBytes(report);
    const signed = signReportBytes(bytes, Keypair.random());
    const wrongKeypair = Keypair.random();

    expect(verifyReportSignature(bytes, signed.signature, wrongKeypair.publicKey())).toBe(false);
  });

  it("also round-trips serializeReportJson output byte-for-byte across two generations", () => {
    const reportA = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-01T00:00:00Z"));
    const reportB = buildFunderReport("2026-09", FIXED_RECORDS, new Date("2026-10-02T00:00:00Z"));
    // JSON output intentionally omits generatedAt-sensitive fields from the row data,
    // but includes generatedAt at the top level for human readers -- rows must match.
    expect(JSON.parse(serializeReportJson(reportA)).rows).toEqual(JSON.parse(serializeReportJson(reportB)).rows);
  });
});
