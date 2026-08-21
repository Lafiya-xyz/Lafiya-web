"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { logError } from "@/lib/logging/logger";
import { CURRENT_POLICY_VERSION } from "@/lib/consent";

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

export async function signUp(
  _prevState: SignUpState | undefined,
  formData: FormData,
): Promise<SignUpState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    consent: formData.get("consent"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    logError("Sign up failed", error, {
      route: "/signup (action: signUp)",
      email: parsed.data.email,
    });
    return { error: error.message };
  }

  if (data.user) {
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
  }

  // If email confirmations are enabled (the default for hosted projects),
  // signUp() succeeds but returns no session until the link is clicked.
  if (!data.session) {
    return {
      info: "Check your email to confirm your account, then sign in.",
    };
  }

  redirect("/profile");
}
