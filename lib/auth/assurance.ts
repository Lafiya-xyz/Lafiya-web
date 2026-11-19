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

/**
 * Issue #968: a recent SIM swap means the phone number that just received
 * an OTP can no longer be trusted as a sole possession factor -- an
 * attacker who ported the number can complete OTP-only sign-in or
 * recovery. When a swap is detected the OTP flow must not proceed on the
 * OTP alone; the caller is told to satisfy a stronger factor instead.
 */
export const SIM_SWAP_STEP_UP_REQUIRED = "SIM_SWAP_STEP_UP_REQUIRED" as const;

/**
 * Stronger verification methods accepted in place of a phone OTP after a
 * recent SIM swap. Ordered from most to least preferred so callers can
 * present the best available option first.
 */
export const SIM_SWAP_ALTERNATIVE_METHODS = [
  "passkey",
  "recovery_code",
  "totp",
] as const;

export type SimSwapAlternativeMethod =
  (typeof SIM_SWAP_ALTERNATIVE_METHODS)[number];

export type SimSwapStepUpDecision =
  | { required: false }
  | {
      required: true;
      code: typeof SIM_SWAP_STEP_UP_REQUIRED;
      /** Methods the caller may offer instead of the blocked OTP. */
      alternatives: readonly SimSwapAlternativeMethod[];
    };

/**
 * Decide whether a detected SIM swap forces stronger verification.
 *
 * Fails closed: `recentSwap` is only treated as "no swap" when it is
 * explicitly `false`. An `undefined`/`null` result (e.g. the provider
 * could not be reached and the flow is configured fail-closed) therefore
 * requires step-up, matching `needsStepUp`'s fail-closed contract.
 *
 * This is a pure decision helper -- it performs no I/O and stores no phone
 * number, so OTP actions can call it after `SimSwapChecker` has already
 * reduced the provider response to a boolean.
 */
export function simSwapStepUpDecision(
  recentSwap: boolean | null | undefined,
): SimSwapStepUpDecision {
  if (recentSwap === false) return { required: false };
  return {
    required: true,
    code: SIM_SWAP_STEP_UP_REQUIRED,
    alternatives: SIM_SWAP_ALTERNATIVE_METHODS,
  };
}
