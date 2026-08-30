"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import {
  checkRateLimit,
  recordFailure,
  recordSuccess,
  getClientIp,
} from "@/lib/rate-limit";

const signInSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
  rememberMe: z.enum(["on"]).optional(),
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
 */
export async function signIn(
  _prevState: SignInState | undefined,
  formData: FormData,
): Promise<SignInState> {
  const rawEmail = formData.get("email");
  const emailInput = typeof rawEmail === "string" ? rawEmail.trim() : rawEmail;

  const parsed = signInSchema.safeParse({
    email: emailInput,
    password: formData.get("password"),
    rememberMe: formData.get("rememberMe"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Normalize email and resolve client IP to form the unique rate limit key
  const email = parsed.data.email.trim().toLowerCase();
  const ip = await getClientIp();
  const rateLimitKey = `signin:${email}:${ip}`;

  // Check if current client + email combination is locked out
  const limitCheck = await checkRateLimit(rateLimitKey);
  if (!limitCheck.allowed) {
    return {
      error: `Too many failed sign-in attempts. Please try again in ${limitCheck.secondsRemaining} seconds.`,
    };
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
    return { error: "Incorrect email or password." };
  }

  // Clear failed attempts on successful sign-in
  await recordSuccess(rateLimitKey);
  redirect("/profile");
}
