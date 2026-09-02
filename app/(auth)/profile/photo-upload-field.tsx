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

    setIsUploading(true);

    const formData = new FormData();
    formData.append("file", file);

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

      const { publicUrl } = await response.json();
      // Revoke the preview URL now that we have the real public URL
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      setPreviewUrl(null);
      // Cache-bust so the new photo shows immediately after an overwrite.
      setPhotoUrl(`${publicUrl}?updated=${Date.now()}`);
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
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-200 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              No photo
            </div>
          );
        })()}
        <label className="cursor-pointer rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900">
          {isUploading ? "Uploading…" : photoUrl ? "Change photo" : "Add photo"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleFileChange}
            disabled={isUploading}
            aria-invalid={activeError ? "true" : undefined}
            aria-describedby={activeError ? "photoUrl-error" : undefined}
            className="hidden"
          />
        </label>
      </div>
      {activeError ? (
        <p
          id="photoUrl-error"
          role="alert"
          className="mt-2 text-sm text-red-600 dark:text-red-400"
        >
          {activeError}
        </p>
      ) : null}
    </div>
  );
}
