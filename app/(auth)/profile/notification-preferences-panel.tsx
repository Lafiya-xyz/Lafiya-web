"use client";

import { useActionState } from "react";

import {
  EVENT_CLASSES,
  type EventClass,
  type NotificationPreferences,
} from "@/lib/notifications/preferences";

import { saveNotificationPreferences } from "./notification-preferences-actions";

const CHANNELS = [
  ["email", "Email"],
  ["sms", "SMS"],
  ["push", "Push"],
] as const;

function toTime(minutes: number | null): string {
  if (minutes === null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Notification preferences, quiet hours and mandatory classes (#804). */
export function NotificationPreferencesPanel({
  preferences,
  emailUnreachable,
}: {
  preferences: NotificationPreferences;
  emailUnreachable: boolean;
}) {
  const [state, formAction, isPending] = useActionState(saveNotificationPreferences, undefined);
  const classes = Object.entries(EVENT_CLASSES) as [EventClass, (typeof EVENT_CLASSES)[EventClass]][];

  return (
    <section className="flex flex-col gap-4" aria-labelledby="notification-preferences-heading">
      <h2 id="notification-preferences-heading" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Notifications
      </h2>

      {emailUnreachable ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          Your email may be unreachable: recent messages to it bounced or were reported as spam, so we have paused
          email. Security alerts will still reach you by SMS — check your email address, or keep SMS enabled.
        </p>
      ) : null}

      <form action={formAction} className="flex flex-col gap-4 text-sm">
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Always on</legend>
          {classes
            .filter(([, m]) => m.priority === "mandatory")
            .map(([cls, m]) => (
              <p key={cls} className="text-zinc-600 dark:text-zinc-400">
                <strong>{m.label}</strong> — cannot be turned off or delayed by quiet hours. {m.why}
              </p>
            ))}
        </fieldset>

        {classes
          .filter(([, m]) => m.priority !== "mandatory")
          .map(([cls, m]) => (
            <fieldset key={cls} className="flex flex-wrap gap-4">
              <legend className="font-medium">{m.label}</legend>
              {CHANNELS.map(([ch, label]) => (
                <label key={ch} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    name={`${cls}.${ch}`}
                    defaultChecked={preferences.channels[cls]?.[ch] !== false}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ))}

        <fieldset className="flex flex-wrap items-end gap-4">
          <legend className="font-medium">Quiet hours</legend>
          <label className="flex flex-col gap-1">
            From
            <input type="time" name="quiet_start" defaultValue={toTime(preferences.quietStart)} />
          </label>
          <label className="flex flex-col gap-1">
            To
            <input type="time" name="quiet_end" defaultValue={toTime(preferences.quietEnd)} />
          </label>
          <label className="flex flex-col gap-1">
            Time zone
            <input type="text" name="timezone" defaultValue={preferences.timezone} aria-describedby="tz-help" />
          </label>
          <p id="tz-help" className="w-full text-xs text-zinc-500">
            Default is West Africa Time (Africa/Lagos). Non-urgent messages are held until quiet hours end.
          </p>
        </fieldset>

        <label className="flex items-center gap-2">
          <input type="checkbox" name="batch_low_priority" defaultChecked={preferences.batchLowPriority} />
          Bundle reminders into a daily digest
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {isPending ? "Saving…" : "Save preferences"}
          </button>
          {state?.error ? <p role="alert" className="text-red-600">{state.error}</p> : null}
          {state?.info ? <p role="status" className="text-green-700">{state.info}</p> : null}
        </div>
      </form>
    </section>
  );
}
