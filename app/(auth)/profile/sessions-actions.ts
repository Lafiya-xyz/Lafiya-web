"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logError } from "@/lib/logging/logger";
import { sessionIdFromAccessToken } from "@/lib/sessions/throttle";
import { createClient } from "@/lib/supabase/server";

export interface SessionActionState {
  error?: string;
  info?: string;
}

const sessionIdSchema = z.uuid();

async function currentSessionId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return sessionIdFromAccessToken(session?.access_token);
}

/**
 * Signs out one other device (#523). revoke_my_session() deletes the auth
 * session, and with it the refresh tokens, but only if the session belongs
 * to the caller. On its next request the revoked device fails getUser() in
 * proxy.ts and is sent to /signin.
 */
export async function revokeSession(
  _prevState: SessionActionState | undefined,
  formData: FormData,
): Promise<SessionActionState> {
  const parsed = sessionIdSchema.safeParse(formData.get("sessionId"));
  if (!parsed.success) {
    return { error: "That session could not be found." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Your session has expired. Please sign in again." };
  }

  if (parsed.data === (await currentSessionId(supabase))) {
    return { error: "Use “Sign out” to end the session on this device." };
  }

  const { data: revoked, error } = await supabase.rpc("revoke_my_session", {
    p_session_id: parsed.data,
  });
  if (error) {
    logError("Failed to revoke session", error, {
      route: "/profile (action: revokeSession)",
      userId: user.id,
    });
    return { error: "We couldn't sign out that device. Please try again." };
  }

  revalidatePath("/profile");
  return {
    info: revoked
      ? "That device has been signed out."
      : "That device was already signed out.",
  };
}

/** "Sign out everywhere else": ends every session except this one. */
export async function revokeOtherSessions(): Promise<SessionActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) {
    logError("Failed to revoke other sessions", error, {
      route: "/profile (action: revokeOtherSessions)",
      userId: user.id,
    });
    return {
      error: "We couldn't sign out your other devices. Please try again.",
    };
  }

  revalidatePath("/profile");
  return { info: "All other devices have been signed out." };
}
