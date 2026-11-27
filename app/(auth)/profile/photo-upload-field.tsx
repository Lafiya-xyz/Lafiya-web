"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Uploads directly to Supabase Storage from the browser on file select
 * (rather than routing the file through the Server Action), then hands the
 * resulting public URL to the rest of the form via a hidden input. Optional
 * — a patient can create a card with no photo.
 *
 * Includes on-device face detection and cropping for privacy:
 * - Detects faces using native FaceDetector API (with WASM fallback)
 * - Auto-crops to primary face, blurs background
 * - Warns on zero/multiple faces, requires user confirmation
 * - All processing happens client-side; editor is lazy-loaded on demand
 */
export function PhotoUploadField({
  userId,
  initialUrl,
  error: serverError,
}: {
  userId: string;
  initialUrl: string | null;
  error?: string;
}) {
  void userId;
  const [photoUrl, setPhotoUrl] = useState(initialUrl);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editorFile, setEditorFile] = useState<File | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  // Revoke object URL on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
    };
  }, []);

  const activeError = localError || serverError;

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      setLocalError("Photo must be a PNG, JPEG, or WebP image.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setLocalError("Photo must be under 5 MB.");
      return;
    }

    setLocalError(null);

    // Revoke previous preview URL before creating a new one
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    // Create a local object URL for immediate preview
    const objectUrl = URL.createObjectURL(file);
    previewUrlRef.current = objectUrl;
    setPreviewUrl(objectUrl);

    // Open the face crop editor (lazy-loaded)
    setEditorFile(file);
    setShowEditor(true);
  }

  async function handleEditorComplete(processedBlob: Blob) {
    setShowEditor(false);
    setEditorFile(null);
    setIsUploading(true);

    const formData = new FormData();
    formData.append("file", processedBlob);

    try {
      const response = await fetch("/api/profile/photo", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        setLocalError(
          result.error || `Upload failed with status ${response.status}`,
        );
        if (previewUrlRef.current) {
          URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = null;
        }
        setPreviewUrl(null);
        setIsUploading(false);
        return;
      }

      const { publicUrl, signedUrl } = await response.json();
      // Revoke the preview URL now that we have the real signed URL
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      setPreviewUrl(null);
      // Store the storage path (stable) in photoUrl for the form hidden input;
      // use the signed URL for preview, cache-busted to force a refresh.
      // Issue #528: never store a signed URL in profiles.photo_url — it expires.
      const preview = signedUrl || publicUrl;
      setPhotoUrl(publicUrl);
      setPreviewUrl(`${preview}?updated=${Date.now()}`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setLocalError(errorMsg || "An unexpected error occurred.");
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      setPreviewUrl(null);
    } finally {
      setIsUploading(false);
    }
  }

  function handleEditorCancel() {
    setShowEditor(false);
    setEditorFile(null);
    // Revoke the preview URL since user cancelled
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }

  function handleEditorError(error: string) {
    setShowEditor(false);
    setEditorFile(null);
    setLocalError(error);
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewUrl(null);
  }

  return (
    <div>
      <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Photo (optional)
      </span>
      <input type="hidden" name="photoUrl" value={photoUrl ?? ""} readOnly />
      <div className="mt-2 flex items-center gap-4">
        {(() => {
          const displayUrl = previewUrl || photoUrl;
          return displayUrl ? (
            <Image
              src={displayUrl}
              alt=""
              width={64}
              height={64}
              // Issue #528: could be a blob URL (local preview) or signed URL — skip
              // Next.js image optimization in either case.
              unoptimized
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-200 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              No photo
            </div>
          );
        })()}
        <label className="cursor-pointer rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 focus-within:ring-2 focus-within:ring-zinc-400 focus-within:ring-offset-0 focus-within:outline-none dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900 dark:focus-within:ring-zinc-600">
          {isUploading ? "Uploading…" : photoUrl ? "Change photo" : "Add photo"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFileChange}
            disabled={isUploading || showEditor}
            aria-invalid={activeError ? "true" : undefined}
            aria-describedby={activeError ? "photoUrl-error" : undefined}
            className="hidden"
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        PNG, JPEG, or WebP. Max size 5 MB.
      </p>
      {activeError ? (
        <p
          id="photoUrl-error"
          role="alert"
          className="mt-2 text-sm text-red-600 dark:text-red-400"
        >
          {activeError}
        </p>
      ) : null}

      {/* Lazy-loaded face crop editor */}
      {showEditor && editorFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          role="dialog"
          aria-modal="true"
          aria-labelledby="face-editor-title"
        >
          <div className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-900">
            <h2
              id="face-editor-title"
              className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100"
            >
              Review your photo
            </h2>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              For privacy, we crop to your face and blur the background. Adjust the
              green box if needed, then confirm.
            </p>
            {/* Dynamic import for zero bundle impact on initial load */}
            <FaceCropEditorWrapper
              file={editorFile}
              onComplete={handleEditorComplete}
              onCancel={handleEditorCancel}
              onError={handleEditorError}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Lazy-loaded wrapper to ensure FaceCropEditor doesn't impact initial bundle
function FaceCropEditorWrapper({
  file,
  onComplete,
  onCancel,
  onError,
}: {
  file: File;
  onComplete: (processedBlob: Blob) => void;
  onCancel: () => void;
  onError: (error: string) => void;
}) {
  const [Component, setComponent] = useState<React.ComponentType<{
    file: File;
    onComplete: (processedBlob: Blob, faceData: any) => void;
    onCancel: () => void;
    onError: (error: string) => void;
  }> | null>(null);

  useEffect(() => {
    import("./face-crop-editor").then((mod) => {
      setComponent(() => mod.FaceCropEditor);
    });
  }, []);

  if (!Component) {
    return (
      <div className="flex flex-col items-center gap-4 p-8" role="status" aria-live="polite">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-zinc-200 border-t-emerald-600" aria-hidden="true" />
        <p className="text-zinc-600 dark:text-zinc-400">Loading editor…</p>
      </div>
    );
  }

  return (
    <Component
      file={file}
      onComplete={(blob) => onComplete(blob)}
      onCancel={onCancel}
      onError={onError}
    />
  );
}
