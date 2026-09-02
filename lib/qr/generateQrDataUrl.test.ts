import { describe, expect, it } from "vitest";

import { generateQrDataUrl, QrCapacityError } from "./generateQrDataUrl";

describe("generateQrDataUrl", () => {
  it("returns a PNG data URL", async () => {
    const url = await generateQrDataUrl(
      "https://lafiya.example/card/11111111-1111-1111-1111-111111111111",
    );
    expect(url).toMatch(/^data:image\/png;base64,/);
  });

  it("produces different output for different input", async () => {
    const a = await generateQrDataUrl("https://lafiya.example/card/aaaa");
    const b = await generateQrDataUrl("https://lafiya.example/card/bbbb");
    expect(a).not.toBe(b);
  });

  it("throws QrCapacityError for an oversized input — never silently producing a broken QR", async () => {
    // QR codes with error-correction level Q top out at 1,273 characters
    // for alphanumeric and less for binary (UTF-8) data. A 4 KB URL is
    // comfortably past any symbol capacity.
    const oversizedUrl = "https://lafiya.example/card/" + "a".repeat(4000);

    await expect(generateQrDataUrl(oversizedUrl)).rejects.toThrow(
      QrCapacityError,
    );
    await expect(generateQrDataUrl(oversizedUrl)).rejects.toThrow(
      /too long to encode as a QR code/,
    );
  });

  it("QrCapacityError is a catchable, named error type", async () => {
    const oversizedUrl = "https://lafiya.example/card/" + "b".repeat(4000);
    let caught: unknown;
    try {
      await generateQrDataUrl(oversizedUrl);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QrCapacityError);
    expect((caught as QrCapacityError).name).toBe("QrCapacityError");
  });

  it("generates a QR code suitable for print (Issue #379)", async () => {
    const url = await generateQrDataUrl(
      "https://lafiya.example/card/11111111-1111-1111-1111-111111111111",
    );

    const base64 = url.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    expect(buffer.length).toBeGreaterThan(2000);
  });
});
