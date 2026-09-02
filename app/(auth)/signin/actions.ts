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
import { formatZodError } from "@/lib/validation/zod";

const signInSchema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export interface SignInState {
  error?: string;
}

/**
 * Server action to handle sign-in.
 * Implements application-level rate limiting keyed on email + IP to protect
 * sensitive patient accounts from credential stuffing and brute-force attacks.
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
    return {
      error: `Too many failed sign-in attempts. Please try again in ${limitCheck.secondsRemaining} seconds.`,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
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
