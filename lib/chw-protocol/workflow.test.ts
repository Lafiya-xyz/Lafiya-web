import { describe, expect, it } from "vitest";
import { ProtocolError } from "./types";
import { assertCurrentRecordHash, assertTransactionHash, projectVerificationStatus } from "./workflow";

describe("CHW verification workflow projection", () => {
  it("distinguishes requested, processing, verified, and failed states", () => {
    expect(projectVerificationStatus("pending")).toBe("requested");
    expect(projectVerificationStatus("leased")).toBe("processing");
    expect(projectVerificationStatus("confirming", "confirming")).toBe("processing");
    expect(projectVerificationStatus("completed")).toBe("verified");
    expect(projectVerificationStatus("failed")).toBe("failed");
  });

  it("expires an abandoned lease", () => {
    expect(projectVerificationStatus("leased", undefined, new Date("2026-01-02"), "2026-01-01T00:00:00.000Z")).toBe("failed");
  });

  it("rejects stale hashes and malformed transaction hashes", () => {
    const hash = "a".repeat(64);
    expect(() => assertCurrentRecordHash(hash, "b".repeat(64))).toThrow(ProtocolError);
    expect(() => assertTransactionHash("not-a-hash")).toThrow(ProtocolError);
    expect(assertTransactionHash(hash.toUpperCase())).toBe(hash);
  });
});
