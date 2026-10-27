/**
 * Dynamic QR Code detector with native BarcodeDetector acceleration
 * and lazy-loaded jsQR fallback.
 */

// Declare BarcodeDetector interface for TypeScript
interface BarcodeDetectorInstance {
  detect(source: HTMLVideoElement | ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats: string[] }): BarcodeDetectorInstance;
      getSupportedFormats?(): Promise<string[]>;
    };
  }
}

let nativeDetector: BarcodeDetectorInstance | null = null;
let nativeChecked = false;

export async function detectQrCode(video: HTMLVideoElement): Promise<string | null> {
  if (typeof window === 'undefined' || !video) return null;

  // 1. Try native BarcodeDetector if available
  if (!nativeChecked) {
    if (typeof window.BarcodeDetector !== 'undefined') {
      try {
        nativeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        nativeDetector = null;
      }
    }
    nativeChecked = true;
  }

  if (nativeDetector) {
    try {
      const barcodes = await nativeDetector.detect(video);
      if (barcodes.length > 0 && barcodes[0].rawValue) {
        return barcodes[0].rawValue;
      }
    } catch {
      // Fallback on detector runtime error
    }
  }

  // 2. Lazy-load fallback only when needed on /scan
  const { decodeVideoFrameWithFallback } = await import('./scanner-fallback');
  return decodeVideoFrameWithFallback(video);
}
