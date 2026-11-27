/**
 * Dynamic Face detector with native FaceDetector acceleration
 * and lazy-loaded WASM fallback.
 *
 * Uses the Shape Detection API (FaceDetector) where available,
 * with a lightweight WASM fallback loaded only on demand.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/FaceDetector
 */

// Declare FaceDetector interface for TypeScript
interface FaceDetectorInstance {
  detect(source: ImageBitmapSource): Promise<Array<Face>>;
}

interface Face {
  boundingBox: DOMRectReadOnly;
  landmarks?: Array<{ type: string; locations: DOMPointReadOnly[] }>;
}

declare global {
  interface Window {
    FaceDetector?: {
      new (options?: FaceDetectorOptions): FaceDetectorInstance;
    };
  }
}

interface FaceDetectorOptions {
  maxDetectedFaces?: number;
  fastMode?: boolean;
}

interface DetectedFace {
  /** Normalized coordinates (0-1) relative to image dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Confidence score (0-1), undefined if not provided by detector */
  confidence?: number;
  /** Pixel coordinates for convenience */
  pixelBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** Result of face detection */
export interface FaceDetectionResult {
  faces: DetectedFace[];
  imageWidth: number;
  imageHeight: number;
}

/** Configuration for the face detector */
export interface FaceDetectorConfig {
  /** Maximum number of faces to detect (default: 10) */
  maxDetectedFaces?: number;
  /** Use fast mode (less accurate, faster) */
  fastMode?: boolean;
  /** Minimum confidence threshold (0-1) */
  minConfidence?: number;
}

let nativeDetector: FaceDetectorInstance | null = null;
let nativeChecked = false;

/**
 * Check if native FaceDetector is available and initialize it.
 * Only runs once per session.
 */
async function ensureNativeDetector(config: FaceDetectorConfig = {}): Promise<FaceDetectorInstance | null> {
  if (typeof window === 'undefined') return null;

  if (!nativeChecked) {
    if (typeof window.FaceDetector !== 'undefined') {
      try {
        nativeDetector = new window.FaceDetector({
          maxDetectedFaces: config.maxDetectedFaces ?? 10,
          fastMode: config.fastMode ?? true,
        });
      } catch {
        nativeDetector = null;
      }
    }
    nativeChecked = true;
  }

  return nativeDetector;
}

/**
 * Convert native FaceDetector results to our normalized format
 */
function normalizeFaces(
  faces: Array<Face>,
  imageWidth: number,
  imageHeight: number,
  minConfidence: number
): DetectedFace[] {
  return faces
    .map((face) => {
      const box = face.boundingBox;
      const confidence = 1; // Native API doesn't provide confidence

      if (confidence < minConfidence) return null;

      return {
        x: box.x / imageWidth,
        y: box.y / imageHeight,
        width: box.width / imageWidth,
        height: box.height / imageHeight,
        confidence,
        pixelBox: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
        },
      };
    })
    .filter((f): f is DetectedFace => f !== null);
}

/**
 * Detect faces using the native FaceDetector API
 */
async function detectWithNative(
  source: ImageBitmapSource,
  config: FaceDetectorConfig
): Promise<FaceDetectionResult | null> {
  const detector = await ensureNativeDetector(config);
  if (!detector) return null;

  try {
    // Get image dimensions
    let imageWidth: number;
    let imageHeight: number;

    if (source instanceof HTMLImageElement) {
      imageWidth = source.naturalWidth || source.width;
      imageHeight = source.naturalHeight || source.height;
    } else if (source instanceof HTMLVideoElement) {
      imageWidth = source.videoWidth;
      imageHeight = source.videoHeight;
    } else if (source instanceof ImageBitmap) {
      imageWidth = source.width;
      imageHeight = source.height;
    } else if (source instanceof HTMLCanvasElement) {
      imageWidth = source.width;
      imageHeight = source.height;
    } else if (source instanceof OffscreenCanvas) {
      imageWidth = source.width;
      imageHeight = source.height;
    } else {
      // For Blob/File, we need to load it first
      return null;
    }

    const faces = await detector.detect(source);
    const normalized = normalizeFaces(faces, imageWidth, imageHeight, config.minConfidence ?? 0);

    return {
      faces: normalized,
      imageWidth,
      imageHeight,
    };
  } catch {
    return null;
  }
}

/**
 * Load and initialize the WASM fallback detector.
 * This is a placeholder that will be implemented with an actual
 * lightweight face detection model (e.g., MediaPipe Face Detection)
 * when needed. For now, it returns null to indicate unavailability.
 */
let wasmDetector: ((source: ImageBitmapSource) => Promise<FaceDetectionResult | null>) | null = null;
let wasmLoadPromise: Promise<void> | null = null;
let wasmChecked = false;

async function ensureWasmDetector(): Promise<typeof wasmDetector> {
  if (wasmChecked) return wasmDetector;

  wasmChecked = true;

  // In production, this would dynamically import a WASM module:
  // const { detectFaces } = await import('./face-detector-wasm');
  // wasmDetector = detectFaces;
  //
  // For now, we return null as a placeholder.
  // The actual implementation would use a lightweight model like
  // MediaPipe Face Detection (compiled to WASM) or a minimal
  // custom model.

  wasmDetector = null;
  return wasmDetector;
}

/**
 * Detect faces in an image using the best available method.
 * Tries native FaceDetector first, falls back to WASM if available.
 *
 * @param source - Image source (HTMLImageElement, HTMLVideoElement, ImageBitmap, HTMLCanvasElement, Blob, File)
 * @param config - Detector configuration
 * @returns Promise resolving to detection results or null if no detector available
 */
export async function detectFaces(
  source: ImageBitmapSource | Blob | File,
  config: FaceDetectorConfig = {}
): Promise<FaceDetectionResult | null> {
  // Handle Blob/File by creating an ImageBitmap
  let imageSource: ImageBitmapSource = source;

  if (source instanceof Blob || source instanceof File) {
    try {
      imageSource = await createImageBitmap(source);
    } catch {
      return null;
    }
  }

  // 1. Try native FaceDetector
  const nativeResult = await detectWithNative(imageSource, config);
  if (nativeResult) return nativeResult;

  // 2. Lazy-load and try WASM fallback
  const wasmDetect = await ensureWasmDetector();
  if (wasmDetect) {
    return wasmDetect(imageSource);
  }

  // No detector available
  return null;
}

/**
 * Get the primary face (largest by area) from detection results.
 * Returns null if no faces detected.
 */
export function getPrimaryFace(result: FaceDetectionResult): DetectedFace | null {
  if (result.faces.length === 0) return null;

  return result.faces.reduce((largest, face) => {
    const faceArea = face.width * face.height;
    const largestArea = largest.width * largest.height;
    return faceArea > largestArea ? face : largest;
  });
}

/**
 * Check if exactly one face is detected.
 */
export function hasSingleFace(result: FaceDetectionResult): boolean {
  return result.faces.length === 1;
}

/**
 * Check if multiple faces are detected.
 */
export function hasMultipleFaces(result: FaceDetectionResult): boolean {
  return result.faces.length > 1;
}

/**
 * Check if no faces are detected.
 */
export function hasNoFaces(result: FaceDetectionResult): boolean {
  return result.faces.length === 0;
}