import { describe, expect, it } from "vitest";

import { generateQrDataUrl } from "./generateQrDataUrl";

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

  it("generates a QR code suitable for print (Issue #379)", async () => {
    const url = await generateQrDataUrl(
      "https://lafiya.example/card/11111111-1111-1111-1111-111111111111",
    );

    const base64 = url.replace(/^data:image\/png;base64,/, "");
    const buffer = Buffer.from(base64, "base64");
    expect(buffer.length).toBeGreaterThan(2000);
  });
});
