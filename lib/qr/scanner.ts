/**
 * @module lib/qr/scanner
 *
 * In-app QR scanner utility and security validator for emergency responders.
 *
 * Implements:
 * - BarcodeDetector API feature detection with fallback to lazy loaded decoder.
 * - Strict URL origin and path validation to prevent open redirects and SSRF/phishing.
 * - Non-Lafiya QR content isolation: arbitrary content is strictly shown as text.
 * - Camera stream lifecycle and torch control.
 */

export interface QrValidationResult {
  isLafiyaCard: boolean;
  targetUrl: string | null;
  displayText: string;
  reason?: string;
}

/** Allowed path prefixes for valid emergency cards */
const ALLOWED_CARD_PATH_PATTERNS = [
  /^\/card\/[0-9a-fA-F-]{36}$/, // /card/[uuid]
  /^\/card\/c\/[A-Za-z0-9_-]+$/, // /card/c/[token]
];

/**
 * Validates a decoded QR code payload strictly against application origins and card paths.
 * Prevents open redirects, spoofed domains, and malicious protocols.
 */
export function validateQrPayload(
  rawText: string,
  allowedOrigin?: string,
): QrValidationResult {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return {
      isLafiyaCard: false,
      targetUrl: null,
      displayText: "",
      reason: "Empty payload",
    };
  }

  // Check if it's a URL
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    // Relative URL or plain text
    if (trimmed.startsWith("/")) {
      try {
        const base = allowedOrigin || (typeof window !== "undefined" ? window.location.origin : "http://localhost:3000");
        parsedUrl = new URL(trimmed, base);
      } catch {
        parsedUrl = null;
      }
    }
  }

  if (!parsedUrl) {
    return {
      isLafiyaCard: false,
      targetUrl: null,
      displayText: trimmed,
      reason: "Plain text payload",
    };
  }

  // Must use http or https protocol
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      isLafiyaCard: false,
      targetUrl: null,
      displayText: trimmed,
      reason: "Forbidden protocol",
    };
  }

  // Origin check
  const currentOrigin =
    allowedOrigin ||
    (typeof window !== "undefined" ? window.location.origin : "");

  let isOriginMatch = false;
  if (currentOrigin) {
    try {
      const allowed = new URL(currentOrigin);
      isOriginMatch = parsedUrl.host.toLowerCase() === allowed.host.toLowerCase();
    } catch {
      isOriginMatch = false;
    }
  }

  // Check path pattern
  const pathname = parsedUrl.pathname;
  const isCardPath = ALLOWED_CARD_PATH_PATTERNS.some((pattern) =>
    pattern.test(pathname),
  );

  if (isOriginMatch && isCardPath) {
    return {
      isLafiyaCard: true,
      targetUrl: `${parsedUrl.pathname}${parsedUrl.search}`,
      displayText: trimmed,
    };
  }

  return {
    isLafiyaCard: false,
    targetUrl: null,
    displayText: trimmed,
    reason: isOriginMatch
      ? "Lafiya URL but not an emergency card path"
      : "External non-Lafiya QR code",
  };
}

/**
 * Feature detection for native BarcodeDetector API.
 */
export function hasBarcodeDetector(): boolean {
  return (
    typeof window !== "undefined" &&
    "BarcodeDetector" in window &&
    typeof (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector ===
      "function"
  );
}

/**
 * Native BarcodeDetector instance cached when supported.
 */
let cachedDetector: {
  detect: (image: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
} | null = null;

export async function getNativeBarcodeDetector() {
  if (!hasBarcodeDetector()) return null;
  if (!cachedDetector) {
    try {
      const BD = (window as unknown as {
        BarcodeDetector: new (opts: { formats: string[] }) => {
          detect: (img: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>;
        };
      }).BarcodeDetector;
      cachedDetector = new BD({ formats: ["qr_code"] });
    } catch {
      return null;
    }
  }
  return cachedDetector;
}

/**
 * Detects QR code from a video element using BarcodeDetector if available,
 * or lazily imported fallback decoder.
 */
export async function detectQrFromVideo(
  video: HTMLVideoElement,
): Promise<string | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return null;
  }

  // 1. Try native BarcodeDetector
  const detector = await getNativeBarcodeDetector();
  if (detector) {
    try {
      const barcodes = await detector.detect(video);
      if (barcodes.length > 0 && barcodes[0].rawValue) {
        return barcodes[0].rawValue;
      }
      return null;
    } catch {
      // Fallback if native detector fails on frame
    }
  }

  // 2. Lazily loaded fallback
  const { decodeVideoFrameWithFallback } = await import("./scanner-fallback");
  return decodeVideoFrameWithFallback(video);
}

/**
 * Checks if torch/flashlight is supported on the active video track.
 */
export function isTorchSupported(stream: MediaStream | null): boolean {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  if (!track) return false;

  const capabilities = track.getCapabilities?.() as { torch?: boolean } | undefined;
  return Boolean(capabilities?.torch);
}

/**
 * Toggles torch mode on the active video track.
 */
export async function setTorchEnabled(
  stream: MediaStream | null,
  enabled: boolean,
): Promise<boolean> {
  if (!stream) return false;
  const track = stream.getVideoTracks()[0];
  if (!track) return false;

  try {
    const constraints = {
      advanced: [{ torch: enabled } as MediaTrackConstraintSet],
    };
    await track.applyConstraints(constraints);
    return true;
  } catch {
    return false;
  }
}
