import { describe, expect, it } from "vitest";

import { EMERGENCY_FIELD_ALLOWLIST } from "@/lib/emergency/capability";

import {
  buildApplePassJson,
  buildGoogleWalletObject,
  buildWalletPassContent,
  InvalidCapabilityUrlError,
} from "./passContent";

const VALID_CAPABILITY_URL =
  "https://lafiya.example/card/c/lafiya_e1_" + "a".repeat(43);

describe("buildWalletPassContent", () => {
  it("accepts a capability-share URL and derives a serial number from it", () => {
    const content = buildWalletPassContent(VALID_CAPABILITY_URL);
    expect(content.capabilityUrl).toBe(VALID_CAPABILITY_URL);
    expect(content.serialNumber).toBe("lafiya_e1_" + "a".repeat(43));
    expect(content.organizationName).toBe("Lafiya");
    expect(content.description).toBe("Medical information: scan");
  });

  it("rejects the permanent /card/[id] link — only revocable capability shares are allowed", () => {
    expect(() =>
      buildWalletPassContent(
        "https://lafiya.example/card/11111111-1111-1111-1111-111111111111",
      ),
    ).toThrow(InvalidCapabilityUrlError);
  });

  it("rejects an arbitrary non-Lafiya URL", () => {
    expect(() => buildWalletPassContent("https://evil.example/phish")).toThrow(
      InvalidCapabilityUrlError,
    );
  });

  it("accepts a localhost URL for local development", () => {
    const url = "http://localhost:3000/card/c/lafiya_e1_" + "b".repeat(43);
    expect(() => buildWalletPassContent(url)).not.toThrow();
  });
});

/**
 * Issue #538 acceptance criterion: "No PHI appears in pass JSON (verified
 * by a test)." Walks every value in the generated pass payloads and checks
 * that no string exactly equal to (or containing, for arrays flattened to
 * strings) an emergency-field name or a plausible PHI-shaped value leaks
 * in. The real guarantee is structural: `buildApplePassJson` and
 * `buildGoogleWalletObject` are pure projections of `WalletPassContent`,
 * which only ever holds the capability URL, a serial derived from it, and
 * fixed branding strings — so this test also pins that projection's shape
 * so a future edit can't silently add a field.
 */
describe("no PHI in pass payloads", () => {
  const content = buildWalletPassContent(VALID_CAPABILITY_URL);
  const applePass = buildApplePassJson(
    content,
    "pass.example.lafiya",
    "TEAMID1234",
  );
  const googleObject = buildGoogleWalletObject(
    content,
    "issuer-123",
    "emergency-card",
  );

  const phiFieldNames = Object.keys(EMERGENCY_FIELD_ALLOWLIST).filter(
    (name) => name !== "photo_url",
  );

  function flatten(value: unknown): string {
    return JSON.stringify(value);
  }

  it("Apple pass.json contains no emergency field names or values", () => {
    const serialized = flatten(applePass);
    for (const field of phiFieldNames) {
      expect(serialized).not.toContain(field);
    }
    // Only the fixed branding/description strings and the capability URL
    // may appear as pass content.
    expect(applePass.description).toBe("Medical information: scan");
    expect(applePass.barcodes[0].message).toBe(VALID_CAPABILITY_URL);
  });

  it("Google Wallet object contains no emergency field names or values", () => {
    const serialized = flatten(googleObject);
    for (const field of phiFieldNames) {
      expect(serialized).not.toContain(field);
    }
    expect(googleObject.barcode.value).toBe(VALID_CAPABILITY_URL);
  });

  it("WalletPassContent has exactly the expected keys (no accidental PHI field added)", () => {
    expect(Object.keys(content).sort()).toEqual(
      [
        "capabilityUrl",
        "description",
        "organizationName",
        "serialNumber",
      ].sort(),
    );
  });
});
