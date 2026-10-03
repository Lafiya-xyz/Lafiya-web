/**
 * Issue #528: Signed-URL helper for private avatar bucket.
 *
 * Profile photos are personally identifying. The avatars bucket is now
 * private (see migration 20260930000001). Callers must use this helper
 * to obtain a short-lived signed URL instead of using getPublicUrl().
 *
 * Authorization contexts:
 *   - "owner"     : the authenticated user reading their own profile.
 *   - "card"      : a card-render request resolved through a valid capability
 *                   or legacy card ID (checked by the caller before calling
 *                   this helper — we trust context passed in, not re-validate).
 *
 * The helper uses the service-role admin client so it can generate a signed
 * URL for any path the caller has already authorized. Never call this helper
 * without first verifying the caller is entitled to the photo.
 *
 * TTL: 300 seconds (5 minutes). Short enough that rotating or revoking a
 * card link leaves only a brief window; long enough to survive slow
 * page loads and aggressive CDN edge caches.
 *
 * Image optimization (next/image): signed URLs change on every request so
 * they cannot be cached by Next.js's image optimizer across requests. The
 * <Image> component is still used for layout/lazy-loading benefits, but
 * `unoptimized` is set to true for avatar images so the optimizer never
 * attempts to rewrite the URL. See card-content.tsx and profile photo
 * rendering.
 *
 * Offline envelope: the service worker never caches the signed URL itself;
 * the offline card renders a placeholder or omits the photo (the envelope
 * projection field `photoUrl` is omitted in offline mode — see
 * lib/emergency/offline-source.tsx).
 */

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/** Signed-URL TTL in seconds. */
export const AVATAR_SIGNED_URL_TTL = 300;

/**
 * Derive the storage path for a user's avatar from the URL stored in
 * `profiles.photo_url`. The stored value may be either a legacy public URL
 * (e.g. `https://<host>/storage/v1/object/public/avatars/<user_id>/photo.jpg`)
 * or just a bare path segment (`<user_id>/photo.jpg`). Both are normalised to
 * the bare path so we can call createSignedUrl().
 */
export function avatarPathFromUrl(photoUrl: string): string | null {
  if (!photoUrl) return null;
  // If it looks like a full URL, extract the path after "/avatars/"
  try {
    const parsed = new URL(photoUrl);
    const match = /\/avatars\/(.+)$/.exec(parsed.pathname);
    if (match) return match[1];
  } catch {
    // Not a URL — treat as raw path
  }
  // Bare path already (e.g. "<user_id>/photo.jpg")
  return photoUrl;
}

/**
 * Returns a short-lived signed URL for the given avatar storage path, or
 * null if the path is absent or the signing call fails (defensive: a signing
 * failure must never crash a card render).
 *
 * The caller is responsible for authorization — this helper only generates
 * the URL; it does not verify who is requesting it.
 */
export async function getAvatarSignedUrl(
  photoUrl: string | null,
): Promise<string | null> {
  if (!photoUrl) return null;

  const path = avatarPathFromUrl(photoUrl);
  if (!path) return null;

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from("avatars")
      .createSignedUrl(path, AVATAR_SIGNED_URL_TTL);

    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
