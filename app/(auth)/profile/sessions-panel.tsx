"use client";

import { useActionState } from "react";

import type { UserSessionRow } from "@/lib/supabase/types";

import { revokeOtherSessions, revokeSession } from "./sessions-actions";

export type SessionListItem = Pick<
  UserSessionRow,
  "session_id" | "browser" | "os" | "created_at" | "last_seen_at"
> & { current: boolean };

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function describe(session: SessionListItem): string {
  if (session.browser === "Other" && session.os === "Other") {
    return "Unknown device";
  }
  if (session.os === "Other") return session.browser;
  if (session.browser === "Other") return session.os;
  return `${session.browser} on ${session.os}`;
}

function RevokeButton({
  sessionId,
  label,
}: {
  sessionId: string;
  label: string;
}) {
  const [state, formAction, isPending] = useActionState(
    revokeSession,
    undefined,
  );
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="sessionId" value={sessionId} />
      <button
        type="submit"
        disabled={isPending}
        aria-label={`Sign out ${label}`}
        data-testid="session-revoke"
        className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
      >
        {isPending ? "Signing out…" : "Sign out"}
      </button>
      {state?.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Lists where the patient is signed in and lets them sign out a lost or
 * shared phone (#523). Only the coarse browser/OS family and timestamps are
 * shown: no IP addresses and no locations.
 */
export function SessionsPanel({ sessions }: { sessions: SessionListItem[] }) {
  const [state, formAction, isPending] = useActionState(
    revokeOtherSessions,
    undefined,
  );
  const others = sessions.filter((session) => !session.current);

  return (
    <section
      aria-labelledby="sessions-heading"
      data-testid="sessions-panel"
      className="flex flex-col gap-4"
    >
      <div>
        <h2
          id="sessions-heading"
          className="text-sm font-medium text-zinc-950 dark:text-zinc-50"
        >
          Where you’re signed in
        </h2>
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          If you lost a phone or used a shared device, sign it out here.
          Locations and IP addresses are never recorded.
        </p>
      </div>

      {sessions.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No active sessions have been recorded yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {sessions.map((session) => {
            const label = describe(session);
            return (
              <li
                key={session.session_id}
                data-testid="session-item"
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
                    {label}
                    {session.current ? (
                      <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        This device
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    Last active{" "}
                    <time dateTime={session.last_seen_at}>
                      {dateTime.format(new Date(session.last_seen_at))}
                    </time>
                    {" · "}Signed in{" "}
                    <time dateTime={session.created_at}>
                      {dateTime.format(new Date(session.created_at))}
                    </time>
                  </p>
                </div>
                {session.current ? null : (
                  <RevokeButton sessionId={session.session_id} label={label} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {others.length > 0 ? (
        <form action={formAction}>
          <button
            type="submit"
            disabled={isPending}
            data-testid="sessions-revoke-others"
            className="flex h-10 items-center justify-center rounded-full border border-zinc-300 px-5 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
          >
            {isPending ? "Signing out…" : "Sign out everywhere else"}
          </button>
        </form>
      ) : null}

      {state?.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state?.info ? (
        <p
          role="status"
          className="text-sm text-emerald-600 dark:text-emerald-400"
        >
          {state.info}
        </p>
      ) : null}
    </section>
  );
}
