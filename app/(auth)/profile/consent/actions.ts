"use server";

import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/logging/logger";
import { CURRENT_POLICY_VERSION } from "@/lib/consent";

export interface ConsentHistoryEntry {
  policyVersion: string;
  acceptedAt: string;
}

export interface AcknowledgeResult {
  status: "acknowledged" | "already_acknowledged" | "error";
  error?: string;
}

// Postgres unique-violation error code for the (user_id, policy_version) constraint.
const UNIQUE_VIOLATION = "23505";

/**
 * Returns the signed-in user's own consent records, most-recent first.
 *
 * Cross-user isolation is enforced at two layers:
 *   1. Application: the query is always scoped to the authenticated user's id
 *      (we never accept or forward another user's id).
 *   2. Database: the `consent_logs_select_own` RLS policy restricts reads to
 *      `auth.uid() = user_id`.
 * A missing session or any error yields an empty list rather than leaking
 * another user's data.
 */
export async function getConsentHistory(): Promise<ConsentHistoryEntry[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("consent_logs")
    .select("policy_version, accepted_at")
    .eq("user_id", user.id)
    .order("accepted_at", { ascending: false });

  if (error) {
    logError("Failed to load consent history", error, {
      route: "/profile (action: getConsentHistory)",
      userId: user.id,
    });
    return [];
  }

  return (data ?? []).map((row) => ({
    policyVersion: row.policy_version,
    acceptedAt: row.accepted_at,
  }));
}

/**
 * Records acknowledgement of the currently-active policy version for the
 * signed-in user. Idempotent: re-acknowledging a version that was already
 * recorded (unique (user_id, policy_version) constraint) is treated as
 * success, not an error.
 */
export async function acknowledgeCurrentPolicy(): Promise<AcknowledgeResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { status: "error", error: "Not authenticated" };
  }

  const { error } = await supabase.from("consent_logs").insert({
    user_id: user.id,
    policy_version: CURRENT_POLICY_VERSION,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { status: "already_acknowledged" };
    }
    logError("Failed to acknowledge consent policy", error, {
      route: "/profile (action: acknowledgeCurrentPolicy)",
      userId: user.id,
    });
    return { status: "error", error: error.message };
  }

  return { status: "acknowledged" };
}
