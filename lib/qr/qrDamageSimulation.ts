/**
 * @module qrDamageSimulation
 *
 * Simulates the real-world damage an emergency QR code is likely to suffer
 * once it's laminated onto a physical card: camera blur, a thumb or sticker
 * partially covering the symbol, a washed-out printout, and the aggressive
 * downscaling that happens when a scanner app previews a small print.
 *
 * These operate directly on the raw RGBA pixel data decoded from the
 * generated PNG (see `decodeQr.ts`) — there's no need to re-encode a PNG to
 * re-decode with jsQR, since it reads pixel buffers directly.
 *
 * Transform parameters are deliberately on the harsher end of "should still
 * scan" so that passing the harness in
 * `generateQrDataUrl.damage.test.ts` is meaningful evidence, not a rubber
 * stamp. See docs/qr-code-format.md for the documented rationale.
 */
import type { QrImage } from "./decodeQr";

function cloneImage(image: QrImage): QrImage {
  return {
    data: new Uint8ClampedArray(image.data),
    width: image.width,
    height: image.height,
  };
}

/** Deterministic PRNG (mulberry32) so damage tests are reproducible in CI. */
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

/**
 * Approximates a Gaussian blur with repeated box blurs — a standard, cheap
 * approximation (three box passes converge close to a true Gaussian) that
 * needs no external image library.
 */
export function applyGaussianBlur(image: QrImage, radius = 2): QrImage {
  let current = image;
  for (let pass = 0; pass < 3; pass++) {
    current = boxBlurPass(current, radius);
  }
  return current;
}

function boxBlurPass(image: QrImage, radius: number): QrImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          const idx = (sy * width + sx) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count++;
        }
      }
      const idx = (y * width + x) * 4;
      out[idx] = r / count;
      out[idx + 1] = g / count;
      out[idx + 2] = b / count;
      out[idx + 3] = a / count;
    }
  }

  return { width, height, data: out };
}

/**
 * Blanks out random square blocks covering roughly `fraction` of the
 * image area, simulating a thumb, sticker, or lamination bubble partially
 * occluding the symbol.
 */
export function applyRandomOcclusion(
  image: QrImage,
  fraction = 0.15,
  seed = 1,
): QrImage {
  const result = cloneImage(image);
  const { width, height, data } = result;
  const rand = mulberry32(seed);

  const totalPixels = width * height;
  const targetOccluded = Math.floor(totalPixels * fraction);
  const blockSize = Math.max(1, Math.round(Math.min(width, height) * 0.06));
  let occluded = 0;

  while (occluded < targetOccluded) {
    const bx = Math.floor(rand() * width);
    const by = Math.floor(rand() * height);
    for (let y = by; y < Math.min(height, by + blockSize); y++) {
      for (let x = bx; x < Math.min(width, bx + blockSize); x++) {
        const idx = (y * width + x) * 4;
        // Occlude with mid-gray, opaque — a sticker or lamination bubble,
        // not a transparent hole.
        data[idx] = 128;
        data[idx + 1] = 128;
        data[idx + 2] = 128;
        data[idx + 3] = 255;
        occluded++;
      }
    }
  }

  return result;
}

/**
 * Simulates a faded/washed-out printout by compressing the pixel value
 * range toward mid-gray.
 *
 * @param factor 0 = no change, 1 = fully flattened to mid-gray.
 */
export function applyLowContrast(image: QrImage, factor = 0.6): QrImage {
  const result = cloneImage(image);
  const { data } = result;
  const mid = 128;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] + (mid - data[i]) * factor;
    data[i + 1] = data[i + 1] + (mid - data[i + 1]) * factor;
    data[i + 2] = data[i + 2] + (mid - data[i + 2]) * factor;
    // Alpha untouched.
  }

  return result;
}

/**
 * Nearest-neighbor downscales the image to `targetSize` on its longer side,
 * simulating the print-scaling artefacts of a small laminated card or a
 * scanner app's low-resolution camera preview.
 */
export function downscaleNearest(image: QrImage, targetSize = 150): QrImage {
  const { width, height, data } = image;
  const scale = targetSize / Math.max(width, height);
  const newWidth = Math.max(1, Math.round(width * scale));
  const newHeight = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(newWidth * newHeight * 4);

  for (let y = 0; y < newHeight; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newWidth; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const srcIdx = (sy * width + sx) * 4;
      const dstIdx = (y * newWidth + x) * 4;
      out[dstIdx] = data[srcIdx];
      out[dstIdx + 1] = data[srcIdx + 1];
      out[dstIdx + 2] = data[srcIdx + 2];
      out[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return { width: newWidth, height: newHeight, data: out };
}
