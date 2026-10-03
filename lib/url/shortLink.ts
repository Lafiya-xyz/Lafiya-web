/**
 * Short-link utilities (issue #627, ADR-004).
 *
 * Generates opaque base62 codes (64-bit entropy, 11 characters) for the
 * short-link redirect prototype and manages their persistence.
 *
 * The code maps to `card_public_id`, not to a capability token.
 */

import "server-only";

import { randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/logging/logger";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate an 11-character base62 code from 64 bits of random data.
 * 62^11 ≈ 5.2 × 10^19, providing sufficient entropy against enumeration.
 */
export function generateShortCode(): string {
  // 8 bytes = 64 bits; interpret as an unsigned BigInt for base conversion.
  const buf = randomBytes(8);
  let n = BigInt("0x" + buf.toString("hex"));
  let code = "";
  for (let i = 0; i < 11; i++) {
    code = BASE62[Number(n % 62n)] + code;
    n = n / 62n;
  }
  return code;
}

/**
 * Create or replace the short link for a card.
 * Idempotent: if a short link already exists for `cardPublicId` it is
 * replaced with a new code (called after card regeneration).
 *
 * @returns The new short code, or null on failure (non-fatal).
 */
export async function upsertShortLink(
  cardPublicId: string,
): Promise<string | null> {
  const code = generateShortCode();
  const admin = createAdminClient();

  const { error } = await admin.from(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "short_links" as any,
  ).upsert(
    { code, card_public_id: cardPublicId },
    { onConflict: "card_public_id" },
  );

  if (error) {
    logError("shortLink: failed to upsert short link", error);
    return null;
  }

  return code;
}

/**
 * Delete the short link for a card (called when a card is permanently deleted).
 * Idempotent: no-op if no link exists.
 */
export async function deleteShortLink(cardPublicId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("short_links" as any)
    .delete()
    .eq("card_public_id", cardPublicId);

  if (error) {
    logError("shortLink: failed to delete short link", error);
  }
}
