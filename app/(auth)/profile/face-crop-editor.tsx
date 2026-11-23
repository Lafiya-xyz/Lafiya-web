"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { detectFaces, type FaceDetectionResult, type DetectedFace, getPrimaryFace } from "@/lib/face/face-detector";

interface FaceCropEditorProps {
  /** The image file to process */
  file: File;
  /** Called when processing is complete with the processed blob */
  onComplete: (processedBlob: Blob, faceData: FaceDetectionResult | null) => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Called when an error occurs */
  onError: (error: string) => void;
}

const CANVAS_SIZE = 512; // Max dimension for processing canvas
const BLUR_RADIUS = 30; // Blur radius for background

export function FaceCropEditor({ file, onComplete, onCancel, onError }: FaceCropEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [isProcessing, setIsProcessing] = useState(true);
  const [faceData, setFaceData] = useState<FaceDetectionResult | null>(null);
  const [selectedFace, setSelectedFace] = useState<DetectedFace | null>(null);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [isAdjusting, setIsAdjusting] = useState(false);
  const [adjustMode, setAdjustMode] = useState<"move" | "resize">("move");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [showMultipleFacesWarning, setShowMultipleFacesWarning] = useState(false);
  const [showNoFacesWarning, setShowNoFacesWarning] = useState(false);

  // Load image and detect faces
  useEffect(() => {
    let cancelled = false;

    async function process() {
      try {
        // Create object URL for the image
        const objectUrl = URL.createObjectURL(file);
        const img = new Image();
        img.src = objectUrl;

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Failed to load image"));
        });

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        imgRef.current = img;

        // Detect faces
        const result = await detectFaces(img, { minConfidence: 0.3 });

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        setFaceData(result);

        if (result && result.faces.length > 0) {
          const primary = getPrimaryFace(result);
          if (primary) {
            setSelectedFace(primary);
            // Initialize crop rect to the primary face with some padding
            const padding = 0.3; // 30% padding around face
            const size = Math.max(primary.width, primary.height) * (1 + padding * 2);
            const x = Math.max(0, primary.x - primary.width * padding);
            const y = Math.max(0, primary.y - primary.height * padding);
            setCropRect({ x, y, width: size, height: size });
          }

          if (result.faces.length > 1) {
            setShowMultipleFacesWarning(true);
          }
        } else {
          setShowNoFacesWarning(true);
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : "Failed to process image");
      } finally {
        if (!cancelled) {
          setIsProcessing(false);
        }
      }
    }

    process();

    return () => {
      cancelled = true;
    };
  }, [file, onError]);

  // Draw the canvas with face detection overlay and blur
  useEffect(() => {
    if (!canvasRef.current || !imgRef.current || !faceData || !cropRect) return;

    const canvas = canvasRef.current;
    const img = imgRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Calculate canvas size maintaining aspect ratio
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    let drawWidth = CANVAS_SIZE;
    let drawHeight = CANVAS_SIZE / aspectRatio;
    if (drawHeight > CANVAS_SIZE) {
      drawHeight = CANVAS_SIZE;
      drawWidth = CANVAS_SIZE * aspectRatio;
    }

    canvas.width = drawWidth;
    canvas.height = drawHeight;

    // Draw original image
    ctx.drawImage(img, 0, 0, drawWidth, drawHeight);

    // Apply blur to background (outside crop rect)
    if (cropRect) {
      const cropX = cropRect.x * drawWidth;
      const cropY = cropRect.y * drawHeight;
      const cropW = cropRect.width * drawWidth;
      const cropH = cropRect.height * drawHeight;

      // Save context
      ctx.save();

      // Create a clipping region that excludes the crop area
      ctx.beginPath();
      ctx.rect(0, 0, drawWidth, drawHeight);
      ctx.rect(cropX, cropY, cropW, cropH);
      ctx.clip("evenodd");

      // Apply blur by drawing scaled down and up
      // Note: For production, use ctx.filter = 'blur(30px)' if supported
      // or a more sophisticated blur implementation
      ctx.filter = `blur(${BLUR_RADIUS}px)`;
      ctx.drawImage(img, 0, 0, drawWidth, drawHeight);
      ctx.filter = "none";

      ctx.restore();

      // Draw face detection boxes for all detected faces
      ctx.strokeStyle = "rgba(34, 197, 94, 0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);

      faceData.faces.forEach((face, index) => {
        const faceX = face.x * drawWidth;
        const faceY = face.y * drawHeight;
        const faceW = face.width * drawWidth;
        const faceH = face.height * drawHeight;

        if (face === selectedFace) {
          ctx.strokeStyle = "rgb(34, 197, 94)";
          ctx.lineWidth = 3;
          ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = "rgba(34, 197, 94, 0.5)";
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 5]);
        }

        ctx.strokeRect(faceX, faceY, faceW, faceH);

        // Label
        ctx.fillStyle = "rgb(34, 197, 94)";
        ctx.font = "12px system-ui";
        ctx.fillText(`Face ${index + 1}`, faceX, faceY - 4);
      });

      // Draw crop rectangle (adjustable)
      ctx.strokeStyle = "rgb(255, 255, 255)";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.strokeRect(cropX, cropY, cropW, cropH);

      // Draw resize handles
      const handleSize = 12;
      const handles = [
        { x: cropX, y: cropY }, // top-left
        { x: cropX + cropW, y: cropY }, // top-right
        { x: cropX, y: cropY + cropH }, // bottom-left
        { x: cropX + cropW, y: cropY + cropH }, // bottom-right
      ];

      ctx.fillStyle = "rgb(34, 197, 94)";
      ctx.strokeStyle = "rgb(255, 255, 255)";
      ctx.lineWidth = 2;

      handles.forEach((handle) => {
        ctx.beginPath();
        ctx.arc(handle.x, handle.y, handleSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
    }
  }, [faceData, cropRect, selectedFace, isAdjusting]);

  // Handle mouse/touch events for crop adjustment
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!cropRect || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width * canvas.width;
      const y = (e.clientY - rect.top) / rect.height * canvas.height;

      const cropX = cropRect.x * canvas.width;
      const cropY = cropRect.y * canvas.height;
      const cropW = cropRect.width * canvas.width;
      const cropH = cropRect.height * canvas.height;
      const handleSize = 12;

      // Check if clicking on a resize handle
      const handles = [
        { x: cropX, y: cropY, cursor: "nwse-resize", mode: "resize-tl" },
        { x: cropX + cropW, y: cropY, cursor: "nesw-resize", mode: "resize-tr" },
        { x: cropX, y: cropY + cropH, cursor: "nesw-resize", mode: "resize-bl" },
        { x: cropX + cropW, y: cropY + cropH, cursor: "nwse-resize", mode: "resize-br" },
      ];

      for (const handle of handles) {
        const dx = x - handle.x;
        const dy = y - handle.y;
        if (dx * dx + dy * dy <= (handleSize / 2) * (handleSize / 2)) {
          setIsAdjusting(true);
          setAdjustMode(handle.mode as "resize");
          setDragStart({ x, y });
          canvas.style.cursor = handle.cursor;
          e.preventDefault();
          return;
        }
      }

      // Check if clicking inside crop rect (for moving)
      if (x >= cropX && x <= cropX + cropW && y >= cropY && y <= cropY + cropH) {
        setIsAdjusting(true);
        setAdjustMode("move");
        setDragStart({ x, y });
        canvas.style.cursor = "grabbing";
        e.preventDefault();
      }
    },
    [cropRect]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isAdjusting || !dragStart || !cropRect || !canvasRef.current) return;

      const canvas = canvasRef.current;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width * canvas.width;
      const y = (e.clientY - rect.top) / rect.height * canvas.height;

      const dx = x - dragStart.x;
      const dy = y - dragStart.y;

      const newCrop = { ...cropRect };

      if (adjustMode === "move") {
        newCrop.x = Math.max(0, Math.min(1 - cropRect.width, cropRect.x + dx / canvas.width));
        newCrop.y = Math.max(0, Math.min(1 - cropRect.height, cropRect.y + dy / canvas.height));
      } else if (adjustMode.startsWith("resize")) {
        const isTop = adjustMode.includes("t");
        const isLeft = adjustMode.includes("l");

        if (isLeft) {
          newCrop.x = Math.max(0, Math.min(cropRect.x + cropRect.width - 0.1, cropRect.x + dx / canvas.width));
          newCrop.width = Math.max(0.1, Math.min(1 - newCrop.x, cropRect.width - dx / canvas.width));
        } else {
          newCrop.width = Math.max(0.1, Math.min(1 - cropRect.x, cropRect.width + dx / canvas.width));
        }

        if (isTop) {
          newCrop.y = Math.max(0, Math.min(cropRect.y + cropRect.height - 0.1, cropRect.y + dy / canvas.height));
          newCrop.height = Math.max(0.1, Math.min(1 - newCrop.y, cropRect.height - dy / canvas.height));
        } else {
          newCrop.height = Math.max(0.1, Math.min(1 - cropRect.y, cropRect.height + dy / canvas.height));
        }
      }

      setCropRect(newCrop);
      setDragStart({ x, y });
    },
    [isAdjusting, dragStart, cropRect, adjustMode]
  );

  const handlePointerUp = useCallback(() => {
    setIsAdjusting(false);
    setDragStart(null);
    if (canvasRef.current) {
      canvasRef.current.style.cursor = "";
    }
  }, []);

  // Generate the final processed image
  const generateProcessedImage = useCallback(async () => {
    if (!canvasRef.current || !imgRef.current || !cropRect) return;

    const canvas = canvasRef.current;
    const img = imgRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Create output canvas at original image resolution (or capped)
    const MAX_OUTPUT_DIMENSION = 800;
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    let outWidth = img.naturalWidth;
    let outHeight = img.naturalHeight;

    if (outWidth > MAX_OUTPUT_DIMENSION || outHeight > MAX_OUTPUT_DIMENSION) {
      if (outWidth > outHeight) {
        outWidth = MAX_OUTPUT_DIMENSION;
        outHeight = MAX_OUTPUT_DIMENSION / aspectRatio;
      } else {
        outHeight = MAX_OUTPUT_DIMENSION;
        outWidth = MAX_OUTPUT_DIMENSION * aspectRatio;
      }
    }

    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = outWidth;
    outputCanvas.height = outHeight;
    const outCtx = outputCanvas.getContext("2d");
    if (!outCtx) return;

    // Calculate crop in output coordinates
    const cropX = cropRect.x * outWidth;
    const cropY = cropRect.y * outHeight;
    const cropW = cropRect.width * outWidth;
    const cropH = cropRect.height * outHeight;

    // Draw the cropped region from the original image
    // First, draw the full image to a temp canvas to apply blur
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = outWidth;
    tempCanvas.height = outHeight;
    const tempCtx = tempCanvas.getContext("2d");
    if (!tempCtx) return;

    tempCtx.drawImage(img, 0, 0, outWidth, outHeight);

    // Apply blur to temp canvas (outside crop area)
    // For simplicity, we'll use filter blur on the whole thing then copy the crop region unblurred
    // In production, use a more efficient approach

    // Draw blurred background
    outCtx.filter = `blur(${BLUR_RADIUS}px)`;
    outCtx.drawImage(tempCanvas, 0, 0);
    outCtx.filter = "none";

    // Draw unblurred crop region on top
    outCtx.drawImage(
      tempCanvas,
      cropX, cropY, cropW, cropH,
      cropX, cropY, cropW, cropH
    );

    // Convert to blob
    return new Promise<Blob>((resolve) => {
      outputCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
      }, "image/jpeg", 0.85);
    });
  }, [cropRect]);

  const handleConfirm = async () => {
    setIsProcessing(true);
    try {
      const processedBlob = await generateProcessedImage();
      if (processedBlob) {
        onComplete(processedBlob, faceData);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to generate processed image");
    } finally {
      setIsProcessing(false);
    }
  }, [generateProcessedImage, faceData, onComplete, onError]);

  const handleSkip = () => {
    // User chooses to upload original without face processing
    onComplete(file, faceData);
  };

  if (isProcessing) {
    return (
      <div className="flex flex-col items-center gap-4 p-8" role="status" aria-live="polite">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-zinc-200 border-t-emerald-600" aria-hidden="true" />
        <p className="text-zinc-600 dark:text-zinc-400">Detecting faces…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" role="region" aria-label="Face crop editor">
      {/* Warnings */}
      {showMultipleFacesWarning && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
          role="alert"
          aria-live="assertive"
        >
          <p className="font-medium">Multiple faces detected</p>
          <p className="mt-1">
            We found {faceData?.faces.length} faces in this photo. For privacy, we recommend
            cropping to a single face. You can adjust the crop area below or continue with
            the original photo.
          </p>
        </div>
      )}

      {showNoFacesWarning && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
          role="alert"
          aria-live="assertive"
        >
          <p className="font-medium">No faces detected</p>
          <p className="mt-1">
            We couldn't detect a face in this photo. You can still upload it, but for
            better privacy, consider using a photo with a clear face.
          </p>
        </div>
      )}

      {/* Canvas */}
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="max-w-full h-auto rounded-lg border border-zinc-200 dark:border-zinc-700"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          tabIndex={0}
          role="application"
          aria-label="Face crop editor canvas. Use arrow keys to adjust crop area."
          onKeyDown={(e) => {
            if (!cropRect || !canvasRef.current) return;
            const canvas = canvasRef.current;
            const step = 0.01;
            const newCrop = { ...cropRect };
            switch (e.key) {
              case "ArrowLeft":
                e.preventDefault();
                newCrop.x = Math.max(0, cropRect.x - step);
                break;
              case "ArrowRight":
                e.preventDefault();
                newCrop.x = Math.min(1 - cropRect.width, cropRect.x + step);
                break;
              case "ArrowUp":
                e.preventDefault();
                newCrop.y = Math.max(0, cropRect.y - step);
                break;
              case "ArrowDown":
                e.preventDefault();
                newCrop.y = Math.min(1 - cropRect.height, cropRect.y + step);
                break;
              default:
                return;
            }
            setCropRect(newCrop);
          }}
        />
        {/* Instructions */}
        <div className="absolute bottom-2 left-2 right-2 bg-black/70 text-white text-xs p-2 rounded pointer-events-none">
          Drag the green box to adjust crop. Drag corners to resize. Arrow keys for fine control.
        </div>
      </div>

      {/* Face selection if multiple faces */}
      {faceData && faceData.faces.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Select primary face
          </legend>
          <div className="flex gap-2 overflow-x-auto pb-2" role="radiogroup" aria-label="Detected faces">
            {faceData.faces.map((face, index) => (
              <label
                key={index}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 cursor-pointer transition-colors ${
                  selectedFace === face
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                    : "border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600"
                }`}
              >
                <input
                  type="radio"
                  name="primary-face"
                  checked={selectedFace === face}
                  onChange={() => setSelectedFace(face)}
                  className="sr-only"
                  aria-label={`Face ${index + 1}`}
                />
                <span className="text-sm font-medium">
                  Face {index + 1}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-700">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
        {faceData && faceData.faces.length > 1 && (
          <button
            type="button"
            onClick={handleSkip}
            className="rounded-md border border-amber-500 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
          >
            Upload original
          </button>
        )}
        <button
          type="button"
          onClick={handleConfirm}
          disabled={isProcessing}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {isProcessing ? "Processing…" : "Confirm & Upload"}
        </button>
      </div>
    </div>
  );
}