/**
 * Notification preferences, quiet hours and mandatory-channel rules (issue #804).
 *
 * Enforced inside the notification service (`sendNotification`), never at call
 * sites. Mandatory classes — break-glass card access and sign-in from a new
 * device — ignore every preference, including quiet hours.
 */

import type { NotificationChannel } from "./types";

export type EventClass = "new_device_signin" | "break_glass_access" | "account_updates" | "reminders";
export type Priority = "mandatory" | "normal" | "low";

export const DEFAULT_TIMEZONE = "Africa/Lagos"; // WAT, UTC+1, no DST

export const EVENT_CLASSES: Record<EventClass, { priority: Priority; label: string; why?: string }> = {
  new_device_signin: {
    priority: "mandatory",
    label: "Sign-in from a new device",
    why: "Lets you stop someone else using your account straight away.",
  },
  break_glass_access: {
    priority: "mandatory",
    label: "Emergency (break-glass) card access",
    why: "Your emergency record was opened; you must always be told.",
  },
  account_updates: { priority: "normal", label: "Account and CHW updates" },
  reminders: { priority: "low", label: "Reminders" },
};

export const TEMPLATE_CLASS: Record<string, EventClass> = {
  "security.new_signin": "new_device_signin",
  "emergency.card_accessed": "break_glass_access",
  "chw.verification_complete": "account_updates",
  "chw.reattestation_requested": "reminders",
};

export interface NotificationPreferences {
  timezone: string;
  /** Minutes after local midnight; null disables quiet hours. */
  quietStart: number | null;
  quietEnd: number | null;
  /** Explicit opt-outs: channels[class][channel] === false disables it. */
  channels: Partial<Record<EventClass, Partial<Record<NotificationChannel, boolean>>>>;
  batchLowPriority: boolean;
  /**
   * Safety mode (issue #977). When enabled, non-mandatory notifications are
   * reduced to generic wording or suppressed entirely, and mandatory notices
   * are delivered with neutral copy that never mentions safety mode.
   */
  safetyMode: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  timezone: DEFAULT_TIMEZONE,
  quietStart: null,
  quietEnd: null,
  channels: {},
  batchLowPriority: true,
  safetyMode: false,
};

/**
 * Neutral copy used while safety mode is active. Nothing here may hint that
 * safety mode was enabled or that any protective action was taken.
 */
export const SAFETY_MODE_GENERIC_BODY = "Your settings were updated";

/** Templates whose content is replaced with generic copy under safety mode. */
export const SAFETY_MODE_GENERIC_TEMPLATES: ReadonlySet<string> = new Set([
  "chw.verification_complete",
  "chw.reattestation_requested",
]);

/**
 * Mandatory templates that must still be delivered under safety mode, but
 * with neutral wording. Their content is never rewritten to mention safety
 * mode; only the surrounding copy is kept generic.
 */
export const SAFETY_MODE_NEUTRAL_MANDATORY_TEMPLATES: ReadonlySet<string> = new Set([
  "security.new_signin",
  "emergency.card_accessed",
]);

/** Neutral bodies for mandatory notices delivered during safety mode. */
export const SAFETY_MODE_MANDATORY_BODY: Record<string, string> = {
  "security.new_signin": "A sign-in to your account was recorded.",
  "emergency.card_accessed": "Your emergency record was accessed.",
};

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight in `timezone` (falls back to WAT). */
export function localMinutes(at: Date, timezone: string): number {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Quiet window is [start, end); wraps past midnight when start > end. */
export function inQuietHours(at: Date, prefs: NotificationPreferences): boolean {
  const { quietStart: s, quietEnd: e } = prefs;
  if (s === null || e === null || s === e) return false;
  const now = localMinutes(at, prefs.timezone);
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export type Decision = "send" | "defer" | "batch" | "skip";

/**
 * Decide what to do with a notification. Unknown templates are treated as
 * mandatory so a missing mapping can never silence a message.
 *
 * Under safety mode (issue #977) mandatory classes are still delivered (never
 * silenced), while non-mandatory notifications are suppressed entirely so no
 * content can reveal that safety mode was enabled.
 */
export function decide(
  template: string,
  channel: NotificationChannel,
  prefs: NotificationPreferences = DEFAULT_PREFERENCES,
  at: Date = new Date(),
): Decision {
  const cls = TEMPLATE_CLASS[template];
  if (!cls || EVENT_CLASSES[cls].priority === "mandatory") return "send";
  if (prefs.safetyMode) return "skip";
  if (prefs.channels[cls]?.[channel] === false) return "skip";
  if (EVENT_CLASSES[cls].priority === "low" && prefs.batchLowPriority) return "batch";
  if (inQuietHours(at, prefs)) return "defer";
  return "send";
}

export interface RenderedNotification {
  /** Body copy to deliver. */
  body: string;
  /** True when the body was replaced with generic/neutral copy. */
  generic: boolean;
}

/**
 * Render the body for a notification, applying safety-mode suppression.
 *
 * - Non-mandatory templates are replaced with generic copy (or suppressed by
 *   `decide` returning "skip").
 * - Mandatory templates keep their delivery but use neutral wording that never
 *   mentions safety mode.
 * - When safety mode is off, the caller-provided body is returned unchanged.
 */
export function renderBody(
  template: string,
  body: string,
  prefs: NotificationPreferences = DEFAULT_PREFERENCES,
): RenderedNotification {
  if (!prefs.safetyMode) return { body, generic: false };
  const cls = TEMPLATE_CLASS[template];
  if (!cls || EVENT_CLASSES[cls].priority === "mandatory") {
    const neutral = SAFETY_MODE_MANDATORY_BODY[template];
    return neutral ? { body: neutral, generic: true } : { body, generic: false };
  }
  if (SAFETY_MODE_GENERIC_TEMPLATES.has(template)) {
    return { body: SAFETY_MODE_GENERIC_BODY, generic: true };
  }
  return { body: SAFETY_MODE_GENERIC_BODY, generic: true };
}

type Row = {
  timezone: string;
  quiet_start: number | null;
  quiet_end: number | null;
  channels: NotificationPreferences["channels"] | null;
  batch_low_priority: boolean;
  safety_mode?: boolean | null;
};

export function fromRow(row: Row | null): NotificationPreferences {
  if (!row) return DEFAULT_PREFERENCES;
  return {
    timezone: row.timezone || DEFAULT_TIMEZONE,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    channels: row.channels ?? {},
    batchLowPriority: row.batch_low_priority,
    safetyMode: row.safety_mode ?? false,
  };
}
