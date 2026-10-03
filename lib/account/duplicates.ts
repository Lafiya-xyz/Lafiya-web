import "server-only";

import { createHmac } from "node:crypto";

import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

export type BlockingKeyType = "phone" | "name_dob";
export type BlockingKey = { keyType: BlockingKeyType; keyHash: string };

/**
 * Digits-only E.164-style phone. A Nigerian local number (0 + 10 digits) is
 * rewritten with the 234 country code so both spellings of one number match.
 * Returns null for anything too short to identify a person.
 */
export function normalizePhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = `234${digits.slice(1)}`;
  }
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * Name + date-of-birth blocking value: accents removed, case-folded,
 * punctuation dropped, and name tokens sorted so "Yusuf Amina" matches
 * "Amina Yusuf".
 */
export function normalizeNameDob(
  name: string | null | undefined,
  dateOfBirth: string | null | undefined,
): string | null {
  if (!name || !dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    return null;
  }
  const tokens = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  return tokens.length > 0 ? `${tokens.join(" ")}|${dateOfBirth}` : null;
}

/** Keyed hash: without the server secret a key cannot be reversed or linked. */
export function blockingKeyHash(
  secret: string,
  keyType: BlockingKeyType,
  value: string,
): string {
  return createHmac("sha256", secret)
    .update(`lafiya-blocking-key-v1:${keyType}:${value}`)
    .digest("hex");
}

export function computeBlockingKeys(
  secret: string,
  identity: {
    phone?: string | null;
    name?: string | null;
    dateOfBirth?: string | null;
  },
): BlockingKey[] {
  const keys: BlockingKey[] = [];
  const phone = normalizePhone(identity.phone);
  if (phone) {
    keys.push({
      keyType: "phone",
      keyHash: blockingKeyHash(secret, "phone", phone),
    });
  }
  const nameDob = normalizeNameDob(identity.name, identity.dateOfBirth);
  if (nameDob) {
    keys.push({
      keyType: "name_dob",
      keyHash: blockingKeyHash(secret, "name_dob", nameDob),
    });
  }
  return keys;
}

/** Replaces the user's blocking keys with the ones for their current identity. */
export async function syncBlockingKeys(
  admin: AdminClient,
  secret: string,
  userId: string,
  identity: Parameters<typeof computeBlockingKeys>[1],
): Promise<void> {
  const keys = computeBlockingKeys(secret, identity);
  const { error: deleteError } = await admin
    .from("patient_blocking_keys")
    .delete()
    .eq("user_id", userId);
  if (deleteError) throw new Error("BLOCKING_KEYS_UNAVAILABLE");
  if (keys.length === 0) return;
  const { error } = await admin.from("patient_blocking_keys").insert(
    keys.map((key) => ({
      user_id: userId,
      key_type: key.keyType,
      key_hash: key.keyHash,
    })),
  );
  if (error) throw new Error("BLOCKING_KEYS_UNAVAILABLE");
}

/** Only a count is ever revealed to the owner before dual verification. */
export async function countDuplicateCandidates(
  admin: AdminClient,
  userId: string,
): Promise<number> {
  const { data, error } = await admin.rpc("count_duplicate_candidates", {
    p_user_id: userId,
  });
  if (error) throw new Error("DUPLICATE_CHECK_UNAVAILABLE");
  return data ?? 0;
}
