/**
 * @module decodeQr
 *
 * Decodes the PNG data URLs produced by {@link generateQrDataUrl} back into
 * pixel data and, from there, back into the original text payload.
 *
 * This exists so we can prove — in CI, and in the damage-simulation harness
 * in `generateQrDataUrl.damage.test.ts` — that a QR code we generate is
 * actually decodable, rather than only trusting that the encoder ran
 * without throwing.
 */
import jsQR from "jsqr";
import { PNG } from "pngjs";

/** Raw RGBA pixel data, the shared currency between decode and damage simulation. */
export interface QrImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decodes a `data:image/png;base64,...` URL into raw RGBA pixel data. */
export function decodePngDataUrl(dataUrl: string): QrImage {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error("Expected a data:image/png;base64,... URL");
  }
  const buffer = Buffer.from(match[1], "base64");
  const png = PNG.sync.read(buffer);
  return {
    data: new Uint8ClampedArray(
      png.data.buffer,
      png.data.byteOffset,
      png.data.byteLength,
    ),
    width: png.width,
    height: png.height,
  };
}

/**
 * Attempts to decode a QR symbol from raw RGBA pixel data.
 *
 * @returns the decoded text, or `null` if no QR symbol could be found/decoded.
 */
export function decodeQrImage(image: QrImage): string | null {
  const result = jsQR(image.data, image.width, image.height);
  return result?.data ?? null;
}

/**
 * Decodes a QR code PNG data URL straight back to its encoded text.
 *
 * @returns the decoded text, or `null` if the symbol could not be decoded.
 */
export function decodeQrDataUrl(dataUrl: string): string | null {
  return decodeQrImage(decodePngDataUrl(dataUrl));
}
