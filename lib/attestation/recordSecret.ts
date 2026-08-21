import "server-only";

import { randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The only module allowed to read or write public.profile_secrets. That
 * table has zero RLS policies for any role (see the
 * 20260729120000_profile_secrets.sql migration) — the service-role admin
 * client is the sole way to reach it, on purpose, so the per-patient HMAC
 * pepper never has a code path that could serve it to a browser.
 */

/**
 * Looks up a patient's secret by their public card id — used by the
 * unauthenticated public card page, which only ever knows card_public_id,
 * never user_id. Two plain, indexed queries rather than a single embedded
 * select: card_public_id is a unique index on profiles, user_id is the
 * primary key of profile_secrets, so both lookups are cheap, and avoiding
 * PostgREST relationship embedding keeps this hand-typed Database schema
 * simple to keep correct.
 */
export async function getSecretByCardPublicId(
  cardPublicId: string,
): Promise<string | null> {
  const admin = createAdminClient();

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("user_id")
    .eq("card_public_id", cardPublicId)
    .maybeSingle();

  if (profileError || !profile) {
    return null;
  }

  return getSecretByUserId(profile.user_id);
}

/** Looks up a patient's secret directly by user id — used by the authenticated profile page, which already has the caller's own user id. */
export async function getSecretByUserId(
  userId: string,
): Promise<string | null> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("profile_secrets")
    .select("secret")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.secret;
}

/**
 * Ensures a profile_secrets row exists for this user, generating a new
 * random 256-bit secret if none does. Called from upsertProfile right
 * after a profile is created — never regenerates an existing secret (that
 * would silently invalidate every past attestation for this patient, which
 * is exactly the "edited since last verification" case this issue
 * otherwise handles explicitly and deliberately, not incidentally via
 * secret rotation).
 */
export async function ensureRecordSecret(userId: string): Promise<string> {
  const admin = createAdminClient();

  const secret = randomBytes(32).toString("hex");

  const { error } = await admin
    .from("profile_secrets")
    .upsert(
      { user_id: userId, secret },
      { onConflict: "user_id", ignoreDuplicates: true },
    );

  if (error) {
    throw error;
  }

  const persisted = await getSecretByUserId(userId);
  if (!persisted) {
    throw new Error("RECORD_SECRET_UNAVAILABLE");
  }
  return persisted;
}
