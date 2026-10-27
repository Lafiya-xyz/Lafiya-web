/**
 * @module lib/qr/scanner-fallback
 *
 * Lazily-loaded decoder fallback when the browser lacks native BarcodeDetector.
 * Kept isolated in this file so it is split into a separate async chunk
 * and does not bloat critical application bundles.
 */

let fallbackCanvas: HTMLCanvasElement | null = null;
let fallbackCtx: CanvasRenderingContext2D | null = null;

/**
 * Decodes a single video frame using a canvas context and jsQR.
 */
export async function decodeVideoFrameWithFallback(
  video: HTMLVideoElement,
): Promise<string | null> {
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (width === 0 || height === 0) {
    return null;
  }

  if (!fallbackCanvas) {
    fallbackCanvas = document.createElement("canvas");
  }

  // Cap internal processing resolution to 640x480 max for speed on low-end devices
  const scale = Math.min(1, 640 / Math.max(width, height));
  const targetW = Math.floor(width * scale);
  const targetH = Math.floor(height * scale);

  if (fallbackCanvas.width !== targetW || fallbackCanvas.height !== targetH) {
    fallbackCanvas.width = targetW;
    fallbackCanvas.height = targetH;
    fallbackCtx = fallbackCanvas.getContext("2d", { willReadFrequently: true });
  }

  if (!fallbackCtx) return null;

  fallbackCtx.drawImage(video, 0, 0, targetW, targetH);
  const imageData = fallbackCtx.getImageData(0, 0, targetW, targetH);

  // Dynamically import jsQR so it remains strictly inside this lazy chunk
  const jsQR = (await import("jsqr")).default;
  const code = jsQR(imageData.data, targetW, targetH, {
    inversionAttempts: "dontInvert",
  });

  return code?.data ?? null;
}
