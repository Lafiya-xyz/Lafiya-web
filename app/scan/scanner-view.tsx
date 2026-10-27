"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  detectQrFromVideo,
  hasBarcodeDetector,
  isTorchSupported,
  setTorchEnabled,
  validateQrPayload,
  QrValidationResult,
} from "../../lib/qr/scanner";

export function ScannerView() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef<boolean>(true);

  const [hasCameraPermission, setHasCameraPermission] = useState<boolean | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [torchAvailable, setTorchAvailable] = useState<boolean>(false);
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [detectedResult, setDetectedResult] = useState<QrValidationResult | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [usingNative, setUsingNative] = useState<boolean>(false);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async (facing: "environment" | "user") => {
    stopStream();
    setErrorMessage(null);
    setTorchOn(false);
    setTorchAvailable(false);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API is not supported in this browser.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      setHasCameraPermission(true);
      setTorchAvailable(isTorchSupported(stream));
      setUsingNative(hasBarcodeDetector());
    } catch (err: unknown) {
      setHasCameraPermission(false);
      const error = err as { name?: string; message?: string };
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        setErrorMessage("Camera access was denied. Please grant camera permission in your browser settings to scan emergency cards.");
      } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        setErrorMessage("No camera was found on this device.");
      } else {
        setErrorMessage(error.message || "Unable to access the camera.");
      }
    }
  }, [stopStream]);

  // Start camera on mount
  useEffect(() => {
    startCamera(facingMode);
    return () => {
      stopStream();
    };
  }, [facingMode, startCamera, stopStream]);

  // Continuous frame scanning loop
  useEffect(() => {
    let animationFrameId: number;
    let lastScanTime = 0;

    const scanLoop = async (time: number) => {
      // Throttle scans to every 150ms to save battery and CPU
      if (
        scanningRef.current &&
        videoRef.current &&
        !detectedResult &&
        time - lastScanTime > 150
      ) {
        lastScanTime = time;
        try {
          const rawPayload = await detectQrFromVideo(videoRef.current);
          if (rawPayload && scanningRef.current) {
            scanningRef.current = false;
            const validation = validateQrPayload(rawPayload);
            setDetectedResult(validation);
          }
        } catch {
          // Ignore transient decode errors
        }
      }

      if (!detectedResult) {
        animationFrameId = requestAnimationFrame(scanLoop);
      }
    };

    animationFrameId = requestAnimationFrame(scanLoop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [detectedResult]);

  const handleToggleTorch = async () => {
    const nextState = !torchOn;
    const success = await setTorchEnabled(streamRef.current, nextState);
    if (success) {
      setTorchOn(nextState);
    }
  };

  const handleToggleFacingMode = () => {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"));
  };

  const handleResumeScan = () => {
    setDetectedResult(null);
    setCopied(false);
    scanningRef.current = true;
  };

  const handleCopyText = async () => {
    if (detectedResult?.displayText) {
      await navigator.clipboard.writeText(detectedResult.displayText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="relative min-h-[calc(100vh-4rem)] flex flex-col bg-zinc-950 text-white">
      {/* Top action bar */}
      <div className="absolute top-0 inset-x-0 z-20 flex items-center justify-between p-4 bg-gradient-to-b from-black/80 to-transparent">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-800/80 backdrop-blur text-sm text-zinc-200 hover:text-white"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Exit
        </Link>

        <div className="flex items-center gap-2">
          {torchAvailable && (
            <button
              type="button"
              onClick={handleToggleTorch}
              aria-label={torchOn ? "Turn off torch" : "Turn on torch"}
              className={`p-2 rounded-full backdrop-blur transition-colors ${
                torchOn ? "bg-amber-400 text-black" : "bg-zinc-800/80 text-white"
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </button>
          )}

          <button
            type="button"
            onClick={handleToggleFacingMode}
            aria-label="Switch camera"
            className="p-2 rounded-full bg-zinc-800/80 backdrop-blur text-white hover:bg-zinc-700"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Viewfinder area */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        {hasCameraPermission === false ? (
          <div className="max-w-md p-6 mx-4 text-center bg-zinc-900 border border-zinc-800 rounded-xl">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-red-950/60 flex items-center justify-center text-red-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold mb-2">Camera Unavailable</h2>
            <p className="text-sm text-zinc-400 mb-6">{errorMessage}</p>
            <button
              type="button"
              onClick={() => startCamera(facingMode)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium"
            >
              Try Again
            </button>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 w-full h-full object-cover"
            />

            {/* Target reticle overlay */}
            <div className="relative z-10 w-64 h-64 border-2 border-emerald-400/80 rounded-2xl shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] pointer-events-none flex items-center justify-center">
              <div className="w-full h-0.5 bg-emerald-400/80 animate-pulse" />
              <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-emerald-300" />
              <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-emerald-300" />
              <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-emerald-300" />
              <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-emerald-300" />
            </div>

            <div className="absolute bottom-8 inset-x-0 z-10 text-center pointer-events-none">
              <p className="text-sm font-medium text-white/90 drop-shadow">
                Point camera at emergency QR code
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {usingNative ? "Hardware decoder active" : "WASM decoder active"}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Detection Result Bottom Sheet / Modal */}
      {detectedResult && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="scan-result-title"
          className="fixed inset-x-0 bottom-0 z-50 p-6 bg-zinc-900 border-t border-zinc-800 rounded-t-2xl max-w-lg mx-auto shadow-2xl"
        >
          {detectedResult.isLafiyaCard && detectedResult.targetUrl ? (
            <div>
              <div className="flex items-center gap-2 mb-2 text-emerald-400">
                <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
                <h2 id="scan-result-title" className="text-lg font-semibold text-white">
                  Emergency Card Verified
                </h2>
              </div>
              <p className="text-sm text-zinc-300 mb-4">
                A valid emergency card URL was detected.
              </p>
              <div className="bg-zinc-950 p-3 rounded-lg font-mono text-xs text-zinc-400 break-all mb-4">
                {detectedResult.targetUrl}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => router.push(detectedResult.targetUrl!)}
                  className="flex-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium text-sm text-center"
                >
                  Open Card
                </button>
                <button
                  type="button"
                  onClick={handleResumeScan}
                  className="py-2.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg font-medium text-sm"
                >
                  Scan Another
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-2 text-amber-400">
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h2 id="scan-result-title" className="text-lg font-semibold text-white">
                  Non-Lafiya QR Content
                </h2>
              </div>
              <p className="text-xs text-zinc-400 mb-3">
                For security reasons, non-Lafiya links are never opened automatically to prevent phishing and unauthorized redirection.
              </p>
              <div className="bg-zinc-950 p-3 rounded-lg font-mono text-xs text-zinc-300 break-all max-h-32 overflow-y-auto mb-4 border border-zinc-800">
                {detectedResult.displayText}
              </div>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleCopyText}
                  className="flex-1 py-2.5 px-4 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg font-medium text-sm"
                >
                  {copied ? "Copied to Clipboard!" : "Copy Text"}
                </button>
                <button
                  type="button"
                  onClick={handleResumeScan}
                  className="py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium text-sm"
                >
                  Scan Another
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
