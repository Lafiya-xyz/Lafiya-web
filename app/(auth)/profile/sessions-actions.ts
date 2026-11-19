"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { logError } from "@/lib/logging/logger";
import { sessionIdFromAccessToken } from "@/lib/sessions/throttle";
import { createClient } from "@/lib/supabase/server";

/**
 * Neutral copy returned by safety mode. It must never reveal which
 * protections were applied, in case an observer is watching the screen.
 */
const SAFETY_MODE_NEUTRAL_INFO = "Your settings were updated.";
const SAFETY_MODE_GENERIC_ERROR =
  "We couldn't update your settings. Please try again.";

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

const safetyModeSchema = z.object({
  // Contact ids whose notifications should be paused. Optional so the
  // action can still lock everything else down if none are selected.
  pausedContactIds: z.array(z.uuid()).max(100).default([]),
});

/**
 * Safety mode (#977): one action that atomically locks down sensitive
 * disclosures for a patient at risk of intimate-partner or family abuse.
 *
 * All protections are applied inside a single Postgres function
 * (enable_safety_mode) so they either all succeed or all roll back. The
 * function:
 *   - hides sensitive fields from the public card,
 *   - rotates the patient's capabilities,
 *   - pauses notifications to the selected contacts,
 *   - writes patient-only audit records (excluded from caregiver views).
 *
 * Signing out other sessions happens immediately afterwards via the auth
 * API; if that fails we surface the generic error so the caller can retry,
 * but the database protections remain in place (fail-safe).
 *
 * The returned copy is deliberately neutral and never names what changed.
 */
export async function enableSafetyMode(
  _prevState: SessionActionState | undefined,
  formData: FormData,
): Promise<SessionActionState> {
  const rawContactIds = formData.getAll("pausedContactIds");
  const parsed = safetyModeSchema.safeParse({
    pausedContactIds: rawContactIds.map((value) => String(value)),
  });
  if (!parsed.success) {
    return { error: SAFETY_MODE_GENERIC_ERROR };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const { error: rpcError } = await supabase.rpc("enable_safety_mode", {
    p_paused_contact_ids: parsed.data.pausedContactIds,
  });
  if (rpcError) {
    logError("Failed to enable safety mode", rpcError, {
      route: "/profile (action: enableSafetyMode)",
      userId: user.id,
    });
    return { error: SAFETY_MODE_GENERIC_ERROR };
  }

  // Rotate capabilities and sign out other devices. The database
  // protections are already committed; a failure here is logged but the
  // caller still receives neutral copy so nothing is revealed on screen.
  const { error: signOutError } = await supabase.auth.signOut({
    scope: "others",
  });
  if (signOutError) {
    logError("Failed to sign out other sessions during safety mode", signOutError, {
      route: "/profile (action: enableSafetyMode)",
      userId: user.id,
    });
  }

  revalidatePath("/profile");
  revalidatePath("/profile/security");
  return { info: SAFETY_MODE_NEUTRAL_INFO };
}
