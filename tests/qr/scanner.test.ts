import { describe, expect, it } from "vitest";
import {
  validateQrPayload,
  hasBarcodeDetector,
  isTorchSupported,
} from "../../lib/qr/scanner";

describe("QR Scanner Security & Validation", () => {
  const allowedOrigin = "https://lafiya.app";

  it("validates direct card UUID URLs from trusted origin", () => {
    const validUuidUrl = "https://lafiya.app/card/12345678-1234-1234-1234-123456789abc";
    const result = validateQrPayload(validUuidUrl, allowedOrigin);

    expect(result.isLafiyaCard).toBe(true);
    expect(result.targetUrl).toBe("/card/12345678-1234-1234-1234-123456789abc");
  });

  it("validates tokenized card URLs from trusted origin", () => {
    const validTokenUrl = "https://lafiya.app/card/c/secret_share_token_123";
    const result = validateQrPayload(validTokenUrl, allowedOrigin);

    expect(result.isLafiyaCard).toBe(true);
    expect(result.targetUrl).toBe("/card/c/secret_share_token_123");
  });

  it("rejects non-Lafiya domain URLs to prevent open redirects", () => {
    const maliciousUrl = "https://attacker.com/card/12345678-1234-1234-1234-123456789abc";
    const result = validateQrPayload(maliciousUrl, allowedOrigin);

    expect(result.isLafiyaCard).toBe(false);
    expect(result.targetUrl).toBeNull();
    expect(result.displayText).toBe(maliciousUrl);
    expect(result.reason).toContain("External non-Lafiya QR code");
  });

  it("rejects domain spoofing and subdomain attacks", () => {
    const spoofUrl = "https://lafiya.app.attacker.com/card/12345678-1234-1234-1234-123456789abc";
    const result = validateQrPayload(spoofUrl, allowedOrigin);

    expect(result.isLafiyaCard).toBe(false);
    expect(result.targetUrl).toBeNull();
  });

  it("rejects javascript: and dangerous pseudoprotocols", () => {
    const xssPayload = "javascript:alert(document.cookie)";
    const result = validateQrPayload(xssPayload, allowedOrigin);

    expect(result.isLafiyaCard).toBe(false);
    expect(result.targetUrl).toBeNull();
    expect(result.displayText).toBe(xssPayload);
  });

  it("displays plain text QR content safely as text", () => {
    const textPayload = "Blood Type: O+, Allergies: Penicillin";
    const result = validateQrPayload(textPayload, allowedOrigin);

    expect(result.isLafiyaCard).toBe(false);
    expect(result.targetUrl).toBeNull();
    expect(result.displayText).toBe(textPayload);
  });

  it("rejects internal paths that are not emergency card views", () => {
    const adminUrl = "https://lafiya.app/admin/users";
    const result = validateQrPayload(adminUrl, allowedOrigin);

    expect(result.isLafiyaCard).toBe(false);
    expect(result.targetUrl).toBeNull();
  });

  it("handles torch detection gracefully when stream is null", () => {
    expect(isTorchSupported(null)).toBe(false);
  });

  it("returns false for BarcodeDetector in node/test environment", () => {
    expect(hasBarcodeDetector()).toBe(false);
  });
});
