"use server";

import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { SIGN_UP_CHECK_EMAIL_MESSAGE } from "@/lib/auth/messages";
import { logError } from "@/lib/logging/logger";
import { CURRENT_POLICY_VERSION } from "@/lib/consent";
import {
  SIGN_UP_TIMING_FLOOR_MS,
  withTimingFloor,
} from "@/lib/security/timing";
import { formatZodError } from "@/lib/validation/zod";
import { isBreachedPassword } from "@/lib/security/breached-password";

const signUpSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  consent: z
    .string()
    .transform((val) => val === "on")
    .refine((val) => val, "You must accept the privacy policy to continue"),
});

export interface SignUpState {
  error?: string;
  info?: string;
}

const CHECK_EMAIL: SignUpState = { info: SIGN_UP_CHECK_EMAIL_MESSAGE };

// Supabase error codes (and legacy message fragments) that mean "this email
// already has an account" or "an email was recently sent to it". Both depend
// on the account existing, so both must look like a normal sign-up.
const EXISTENCE_DEPENDENT_CODES = new Set([
  "user_already_exists",
  "email_exists",
  "over_email_send_rate_limit",
]);
const EXISTENCE_DEPENDENT_MESSAGES = [
  "already registered",
  "already exists",
  "for security purposes",
  "rate limit",
];

function isExistenceDependentError(error: {
  code?: string;
  status?: number;
  message: string;
}): boolean {
  const message = error.message.toLowerCase();
  return (
    (error.code !== undefined && EXISTENCE_DEPENDENT_CODES.has(error.code)) ||
    error.status === 429 ||
    EXISTENCE_DEPENDENT_MESSAGES.some((fragment) => message.includes(fragment))
  );
}

/**
 * Sign-up is account-enumeration resistant (#527). Every well-formed request
 * for a new email, an existing email, or a rate-limited email returns the
 * same `info` body, never redirects, and takes at least
 * SIGN_UP_TIMING_FLOOR_MS. Only input problems that do not depend on the
 * email (invalid format, missing consent, weak password) are reported as
 * errors.
 */
export async function signUp(
  _prevState: SignUpState | undefined,
  formData: FormData,
): Promise<SignUpState> {
  return withTimingFloor(SIGN_UP_TIMING_FLOOR_MS, () =>
    createAccount(formData),
  );
}

async function createAccount(formData: FormData): Promise<SignUpState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    consent: formData.get("consent"),
  });

  if (!parsed.success) {
    return { error: formatZodError(parsed.error).error };
  }

  if (await isBreachedPassword(parsed.data.password)) {
    return {
      error:
        "This password has appeared in a known data breach. Please choose a different password.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    if (isExistenceDependentError(error)) {
      // Expected for an existing account. It is not logged: a log line tying
      // an email to "already registered" would itself record who holds an
      // account.
      return CHECK_EMAIL;
    }
    // The email is deliberately not logged (#527).
    logError("Sign up failed", error, { route: "/signup (action: signUp)" });
    if (
      error.code === "weak_password" ||
      error.message.toLowerCase().includes("password")
    ) {
      return {
        ok: true as const,
        data: {
          info: "Check your email to confirm your account, then sign in.",
        },
      };
    }

  // With email confirmations on, Supabase answers an already-registered
  // email with an obfuscated user that has no identities, and no error.
  // No account was created, so there is no consent to record.
  if (!data.user || (data.user.identities?.length ?? 0) === 0) {
    return CHECK_EMAIL;
  }

  const adminClient = createAdminClient();
  const { error: consentError } = await adminClient
    .from("consent_logs")
    .insert({
      user_id: data.user.id,
      policy_version: CURRENT_POLICY_VERSION,
    });

  if (consentError) {
    logError("Failed to record user consent", consentError, {
      route: "/signup (action: signUp)",
      userId: data.user.id,
    });
    // Rollback auth user creation if consent recording fails
    await adminClient.auth.admin.deleteUser(data.user.id);
    return { error: "Failed to record consent. Please try again." };
  }

  // When confirmations are off (e.g. local Supabase), signUp() also signs the
  // new user in. Redirecting them to /profile would differ from the
  // existing-email outcome, so end that session and send them to sign in
  // like everyone else.
  if (data.session) {
    await supabase.auth.signOut({ scope: "local" });
  }

  return CHECK_EMAIL;
}
