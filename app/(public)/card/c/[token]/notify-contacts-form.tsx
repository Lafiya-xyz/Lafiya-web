"use client";

import { useActionState, useRef } from "react";

import { notifyEmergencyContacts } from "./actions";

/**
 * Issue #542: lets a responder viewing a capability-share card notify the
 * patient's emergency contacts, only shown when the card actually discloses
 * emergency contacts (consent for the notification itself is re-checked
 * server-side in notify_emergency_contacts() -- this button doesn't know
 * whether the patient opted in, so "not opted in" is just one of the
 * possible error states surfaced after submit).
 */
export function NotifyContactsForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState(
    notifyEmergencyContacts,
    undefined,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <section
      aria-labelledby="notify-contacts-heading"
      className="rounded-lg border border-zinc-300 p-4 dark:border-zinc-700"
    >
      <h2 id="notify-contacts-heading" className="text-sm font-medium">
        Let the family know
      </h2>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        With the patient&apos;s consent, you can send their emergency
        contacts a message saying they are receiving care. No medical
        details are shared.
      </p>

      {state?.status === "sent" ? (
        <p className="mt-3 text-sm text-green-700 dark:text-green-400">
          Notification sent to the patient&apos;s emergency contacts.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => dialogRef.current?.showModal()}
          className="mt-3 min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
        >
          Notify emergency contacts
        </button>
      )}

      <dialog
        ref={dialogRef}
        className="w-full max-w-sm rounded-xl border border-zinc-300 bg-white p-6 text-zinc-950 backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      >
        <form action={formAction}>
          <h2 className="text-lg font-semibold">Notify emergency contacts?</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            This sends a templated message only -- it never includes health
            information. Limited to one notification per card every 30
            minutes.
          </p>

          <input type="hidden" name="token" value={token} />

          <label className="mt-4 block text-sm">
            Facility name (optional)
            <input
              type="text"
              name="facilityName"
              maxLength={120}
              placeholder="e.g. General Hospital"
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:focus:ring-zinc-600"
            />
          </label>

          {state?.status === "error" ? (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="min-h-11 rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:focus:ring-zinc-600"
            >
              {isPending ? "Sending…" : "Send notification"}
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
