/**
 * Decode round-trip and damage-simulation harness for the emergency QR
 * code (issue #540). A QR that fails to scan in an emergency is a silent,
 * life-critical failure, so every capability URL format we issue must be
 * proven decodable — including after the kind of physical damage a
 * laminated card actually suffers.
 *
 * See docs/qr-code-format.md ("Verification") for the documented rationale
 * and the evidence this suite produces.
 */
import { describe, expect, it } from "vitest";

import { decodePngDataUrl, decodeQrImage } from "./decodeQr";
import { generateQrDataUrl } from "./generateQrDataUrl";
import {
  applyGaussianBlur,
  applyLowContrast,
  applyRandomOcclusion,
  downscaleNearest,
  type QrImage,
} from "./qrDamageSimulation";

/** Mirrors the card host used in production callers (see qr-card-display.tsx). */
const HOST = "https://lafiya.example";

/** Deterministic PRNG so the property test is reproducible in CI. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A versioned, URL-safe 256-bit capability token, matching ADR-003's `/card/c/<capability>` format. */
function randomCapabilityToken(rand: () => number): string {
  // 256 bits, base64url-encoded, is 43 characters; prefix with a version tag
  // (e.g. "v1.") as ADR-003 specifies "a versioned, URL-safe token".
  let token = "v1.";
  for (let i = 0; i < 43; i++) {
    token += BASE64URL_ALPHABET[Math.floor(rand() * BASE64URL_ALPHABET.length)];
  }
  return token;
}

const CAPABILITY_URLS = Array.from({ length: 8 }, (_, i) =>
  `${HOST}/card/c/${randomCapabilityToken(mulberry32(1000 + i))}`,
);

const LEGACY_URL = `${HOST}/card/11111111-1111-1111-1111-111111111111`;

/** Applies each damage transform, individually, plus a combined worst case. */
function damageVariants(image: QrImage): Record<string, QrImage> {
  return {
    blur: applyGaussianBlur(image, 2),
    occlusion: applyRandomOcclusion(image, 0.15, 42),
    lowContrast: applyLowContrast(image, 0.6),
    downscale: downscaleNearest(image, 150),
    combined: downscaleNearest(
      applyLowContrast(applyRandomOcclusion(applyGaussianBlur(image, 1), 0.1, 7), 0.35),
      150,
    ),
  };
}

async function generateAndDecode(url: string): Promise<{
  image: QrImage;
  decoded: string | null;
}> {
  const dataUrl = await generateQrDataUrl(url);
  const image = decodePngDataUrl(dataUrl);
  return { image, decoded: decodeQrImage(image) };
}

describe("QR decode round-trip", () => {
  it("decodes back to the exact original URL for the legacy /card/<uuid> format", async () => {
    const { decoded } = await generateAndDecode(LEGACY_URL);
    expect(decoded).toBe(LEGACY_URL);
  });

  it("decodes back to the exact original URL for the /card/c/<capability> format", async () => {
    const { decoded } = await generateAndDecode(CAPABILITY_URLS[0]);
    expect(decoded).toBe(CAPABILITY_URLS[0]);
  });
});

describe("QR damage simulation harness", () => {
  const cases: Array<[string, string]> = [
    ["legacy /card/<uuid>", LEGACY_URL],
    ["/card/c/<capability>", CAPABILITY_URLS[0]],
  ];

  for (const [label, url] of cases) {
    describe(label, () => {
      it("decodes after each individual and combined damage transform", async () => {
        const { image } = await generateAndDecode(url);
        const variants = damageVariants(image);

        for (const [name, damaged] of Object.entries(variants)) {
          const decoded = decodeQrImage(damaged);
          expect(decoded, `expected "${name}" damage to still decode`).toBe(url);
        }
      });
    });
  }
});

describe("QR damage simulation harness — property test over capability tokens", () => {
  it("decodes every randomly generated capability URL (fixed maximum length) after each damage transform", async () => {
    for (const url of CAPABILITY_URLS) {
      const { image, decoded } = await generateAndDecode(url);
      expect(decoded).toBe(url);

      const variants = damageVariants(image);
      for (const [name, damaged] of Object.entries(variants)) {
        const damagedDecoded = decodeQrImage(damaged);
        expect(
          damagedDecoded,
          `expected "${name}" damage to still decode for ${url}`,
        ).toBe(url);
      }
    }
  });
});
