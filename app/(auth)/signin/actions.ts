"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  SIGN_IN_FAILED_MESSAGE,
  signInLockedOutMessage,
} from "@/lib/auth/messages";
import {
  SIGN_IN_TIMING_FLOOR_MS,
  withTimingFloor,
} from "@/lib/security/timing";
import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  recordFailure,
  recordSuccess,
  getClientIp,
} from "@/lib/rate-limit";
import { logError } from "@/lib/logging/logger";
import { coarseUserAgent } from "@/lib/sessions/user-agent";
import { formatZodError } from "@/lib/validation/zod";
import { defineAction } from "@/lib/actions/define-action";

const signInSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  // FormData.get() returns null (not undefined) for an absent field — an
  // unchecked "remember me" checkbox is simply omitted from the submission —
  // so this must accept null, not just undefined, or every sign-in with the
  // box unchecked would fail validation.
  rememberMe: z.enum(["on"]).nullish(),
});

export interface SignInState {
  error?: string;
}

/**
 * Server action to handle sign-in.
 * Implements application-level rate limiting keyed on email + IP to protect
 * sensitive patient accounts from credential stuffing and brute-force attacks.
 *
 * Session behavior (Issue #378):
 * Supabase issues a short-lived access token (default 1h) and a refresh token
 * (default 30 days). The `rememberMe` option controls whether the refresh token
 * is stored in localStorage (persists across browser sessions) or
 * sessionStorage (cleared when the tab/window closes). When the checkbox is
 * checked, the session can survive browser restarts for up to the refresh
 * token TTL; when unchecked, closing the tab ends the session.
 *
 * Rate limiting rules:
 * - Attempts 1-4: No restriction.
 * - Attempt 5: Locked out for 30 seconds.
 * - Attempt 6+: Locked out with exponential doubling (30s, 60s, 120s, 240s, 480s, up to 900s max lockout).
 * - Lockouts use a clear, non-enumerating message showing the remaining seconds.
 * - Non-rate-limit authentication failures return a generic "Incorrect email or password."
 *   to avoid revealing email existence.
 *
 * Account enumeration (#527): the body and redirect depend only on whether
 * the credentials are correct, never on whether the email has an account.
 * Every attempt, including a successful one whose redirect() throws, takes
 * at least SIGN_IN_TIMING_FLOOR_MS, so the bcrypt work Supabase does only
 * for existing accounts is not observable as a timing difference.
 */
export async function signIn(
  _prevState: SignInState | undefined,
  formData: FormData,
): Promise<SignInState> {
  return withTimingFloor(SIGN_IN_TIMING_FLOOR_MS, () =>
    attemptSignIn(formData),
  );
}

async function attemptSignIn(formData: FormData): Promise<SignInState> {
  const rawEmail = formData.get("email");
  const emailInput = typeof rawEmail === "string" ? rawEmail.trim() : rawEmail;

  const parsed = signInSchema.safeParse({
    email: emailInput,
    password: formData.get("password"),
    rememberMe: formData.get("rememberMe"),
  });

  if (!parsed.success) {
    return { error: formatZodError(parsed.error).error };
  }

  // Normalize email and resolve client IP to form the unique rate limit key
  const email = parsed.data.email.trim().toLowerCase();
  const ip = await getClientIp();
  const rateLimitKey = `signin:${email}:${ip}`;

  // Check if current client + email combination is locked out
  const limitCheck = await checkRateLimit(rateLimitKey);
  if (!limitCheck.allowed) {
    return { error: signInLockedOutMessage(limitCheck.secondsRemaining) };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      rememberMe: parsed.data.rememberMe === "on",
    },
  });

  if (error) {
    // Record failure to increment failed attempts and trigger lockout if limit reached
    await recordFailure(rateLimitKey);
    return { error: SIGN_IN_FAILED_MESSAGE };
  }

  // Clear failed attempts on successful sign-in
  await recordSuccess(rateLimitKey);

  // Record the new session for the sessions panel (#523). The client now
  // carries the fresh session, so touch_my_session() reads its id from the
  // verified JWT. This is best effort: sign-in must not fail on it.
  const { browser, os } = coarseUserAgent((await headers()).get("user-agent"));
  const { error: sessionError } = await supabase.rpc("touch_my_session", {
    p_browser: browser,
    p_os: os,
  });
  if (sessionError) {
    logError("Failed to record session metadata", sessionError, {
      route: "/signin (action: signIn)",
    });
  }

  redirect("/profile");
}

/**
 * Type-safe wrapper around the sign-in action (Issue #617).
 *
 * Reuses the same schema, rate-limit helpers, and error mapping as `signIn`
 * but routes them through `defineAction` so the action returns a standard
 * discriminated `Result<T, ActionError>` envelope instead of a raw error
 * string. Behaviour is unchanged; only the error surface is normalized.
 */
export const signInAction = defineAction({
  input: signInSchema,
  rateLimit: {
    key: async (input) => {
      const email = input.email.trim().toLowerCase();
      const ip = await getClientIp();
      return `signin:${email}:${ip}`;
    },
    check: checkRateLimit,
    onFailure: recordFailure,
    onSuccess: recordSuccess,
  },
  handler: async (input) => {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
      options: {
        rememberMe: input.rememberMe === "on",
      },
    });

    if (error) {
      return { ok: false, error: { code: "INVALID_CREDENTIALS" } };
    }

    redirect("/profile");
  },
});
