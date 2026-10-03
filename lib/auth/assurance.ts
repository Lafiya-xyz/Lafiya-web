import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Issue #522: high-impact actions (export, account deletion, secret repair,
 * card-id regeneration) currently require only a live session -- a stolen
 * session cookie is enough to exfiltrate a full health record or delete an
 * account. This is the shared code every such action returns when the
 * caller's session doesn't (yet) satisfy the required assurance level, so
 * a client can detect it programmatically rather than string-matching an
 * error message.
 */
export const STEP_UP_REQUIRED = "STEP_UP_REQUIRED" as const;

export type AssuranceLevel = "aal1" | "aal2";

/**
 * True when `supabase`'s current session does not satisfy `level`.
 *
 * Fails closed (returns true -- i.e. blocks the caller) when the assurance
 * level can't be determined at all (e.g. a transient error calling
 * Supabase), since every caller of this is a high-impact action that must
 * never proceed as if verified when we simply don't know.
 *
 * "Users without MFA are unaffected" (Issue #522's own acceptance
 * criterion): `nextLevel` reflects the highest level reachable given the
 * user's *enrolled* factors -- a user with no verified TOTP factor can
 * never reach `nextLevel === "aal2"`, so this returns false for them
 * regardless of `level`, exactly as if the guard weren't there at all.
 */
export async function needsStepUp(
  supabase: SupabaseClient,
  level: AssuranceLevel,
): Promise<boolean> {
  const { data, error } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return true;
  if (data.nextLevel !== level) return false;
  return data.currentLevel !== level;
}
