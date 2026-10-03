"use server";

/**
 * Issue #529: Verified email-change flow with double confirmation.
 *
 * Supabase already has `double_confirm_changes = true` in config.toml, which
 * means Supabase sends confirmation emails to BOTH the old and new address
 * before applying the change. This file adds:
 *
 *   1. initiateEmailChange  — validates the new address, enforces a
 *      frequency limit, calls supabase.auth.updateUser({ email }), which
 *      triggers the double-confirmation flow server-side.
 *
 *   2. cancelEmailChange    — calls the Supabase admin API to cancel a
 *      pending email change and signs out all other sessions so an attacker
 *      who only has the current session cannot silently re-trigger the change.
 *      Exposed via a one-click "this wasn't me" link in the old-address email.
 *
 * Privacy note: new email address is validated and normalised but never
 * logged or sent to third-party error reporters.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { checkAndIncrementFrequency } from "@/lib/frequency-limit";
import { logError } from "@/lib/logging/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Allow at most 3 email-change initiations per 10 minutes per user to
// limit notification spam to the old address.
const EMAIL_CHANGE_MAX = 3;
const EMAIL_CHANGE_WINDOW_SECONDS = 600;

const newEmailSchema = z.object({
  newEmail: z
    .email("Enter a valid email address")
    .max(254, "Email address is too long"),
});

export type EmailChangeState = {
  error?: string;
  success?: boolean;
  /** True when a pending change was detected before initiating. */
  alreadyPending?: boolean;
};

/**
 * Initiates a verified email-change. Supabase sends a confirmation link to
 * the NEW address and (because double_confirm_changes = true) a notification
 * to the OLD address with a cancellation link.
 *
 * The user must be signed in. The new address must differ from the current one.
 */
export async function initiateEmailChange(
  _prev: EmailChangeState | undefined,
  formData: FormData,
): Promise<EmailChangeState> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "You must be signed in to change your email." };
  }

  const parsed = newEmailSchema.safeParse({
    newEmail: formData.get("newEmail"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid email address." };
  }

  const newEmail = parsed.data.newEmail.trim().toLowerCase();

  if (user.email?.toLowerCase() === newEmail) {
    return { error: "That is already your current email address." };
  }

  // Frequency limit: per-user (not per-IP) because the old address gets a
  // notification email on every initiation — cap this to prevent spam.
  const freq = await checkAndIncrementFrequency(
    `email-change:${user.id}`,
    EMAIL_CHANGE_MAX,
    EMAIL_CHANGE_WINDOW_SECONDS,
  );
  if (!freq.allowed) {
    return {
      error: `Too many email-change requests. Please wait ${freq.retryAfterSeconds} seconds before trying again.`,
    };
  }

  // updateUser triggers the double-confirmation flow when
  // double_confirm_changes = true in config.toml / hosted project settings.
  const { error: updateError } = await supabase.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: `${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "")}/auth/v1/callback` },
  );

  if (updateError) {
    logError("Failed to initiate email change", updateError, {
      route: "/profile (action: initiateEmailChange)",
    });
    return {
      error: "Could not initiate email change. Please try again.",
    };
  }

  revalidatePath("/profile");
  return { success: true };
}

export type CancelEmailChangeState = {
  error?: string;
  success?: boolean;
};

/**
 * Cancels a pending email change and signs out all OTHER sessions so an
 * attacker who captured the current session cannot silently re-trigger it.
 *
 * This is the handler for the "this wasn't me" link sent to the old address.
 * Because the link arrives in an email to the CURRENT (old) address and
 * requires the current session, it only works if:
 *   a) the user initiated it themselves (they can cancel cleanly), or
 *   b) an attacker has the current session (they can cancel the change to
 *      prevent takeover, which is the correct outcome — the old address stays).
 */
export async function cancelEmailChange(
  _prev: CancelEmailChangeState | undefined,
  _formData: FormData,
): Promise<CancelEmailChangeState> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: "You must be signed in to cancel an email change." };
  }

  const admin = createAdminClient();

  // Cancel the pending email change by resetting email_change and
  // email_change_token_new on the auth user via the admin API.
  const { error: updateError } = await admin.auth.admin.updateUserById(
    user.id,
    { email: user.email as string },
  );

  if (updateError) {
    logError("Failed to cancel email change", updateError, {
      route: "/profile (action: cancelEmailChange)",
    });
    return { error: "Could not cancel the email change. Please try again." };
  }

  // Sign out all OTHER sessions (scope: "others") so the attacker's session
  // is invalidated even if they hold a valid refresh token for a different
  // device. The current session is kept so the user stays signed in and can
  // see the confirmation.
  await supabase.auth.signOut({ scope: "others" });

  revalidatePath("/profile");
  return { success: true };
}
