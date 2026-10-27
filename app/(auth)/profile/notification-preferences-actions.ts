"use server";

import { revalidatePath } from "next/cache";

import { logError } from "@/lib/logging/logger";
import {
  EVENT_CLASSES,
  isValidTimezone,
  type EventClass,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export interface PreferencesActionState {
  error?: string;
  info?: string;
}

const CHANNELS = ["email", "sms", "push"] as const;

function toMinutes(value: FormDataEntryValue | null): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 1440 ? minutes : null;
}

/**
 * Saves notification preferences (#804). Mandatory classes are never written
 * as opt-outs, whatever the form posts. Every change is appended to
 * notification_preference_audit with the before/after values.
 */
export async function saveNotificationPreferences(
  _prev: PreferencesActionState | undefined,
  formData: FormData,
): Promise<PreferencesActionState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You need to sign in again." };

  const timezone = String(formData.get("timezone") ?? "Africa/Lagos");
  if (!isValidTimezone(timezone)) return { error: "Unknown time zone." };

  const channels: NotificationPreferences["channels"] = {};
  for (const [cls, meta] of Object.entries(EVENT_CLASSES) as [EventClass, (typeof EVENT_CLASSES)[EventClass]][]) {
    if (meta.priority === "mandatory") continue;
    channels[cls] = Object.fromEntries(
      CHANNELS.map((ch) => [ch, formData.get(`${cls}.${ch}`) === "on"]),
    );
  }

  const after = {
    timezone,
    quiet_start: toMinutes(formData.get("quiet_start")),
    quiet_end: toMinutes(formData.get("quiet_end")),
    channels,
    batch_low_priority: formData.get("batch_low_priority") === "on",
  };

  const { data: before } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_preferences" as any)
    .select("timezone, quiet_start, quiet_end, channels, batch_low_priority")
    .eq("user_id", user.id)
    .maybeSingle();

  const { error } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_preferences" as any)
    .upsert({ user_id: user.id, ...after, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) {
    logError("notification preferences: save failed", error);
    return { error: "Could not save your preferences. Please try again." };
  }

  const { error: auditError } = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_preference_audit" as any)
    .insert({ user_id: user.id, before: before ?? null, after });
  if (auditError) logError("notification preferences: audit insert failed", auditError);

  revalidatePath("/profile");
  return { info: "Notification preferences saved." };
}
