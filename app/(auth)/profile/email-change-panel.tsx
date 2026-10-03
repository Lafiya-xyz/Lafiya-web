"use client";

/**
 * Issue #529: Email-change settings panel.
 *
 * Shows:
 *  - Current email address
 *  - A form to request an email change (sends double-confirmation emails)
 *  - Pending-change status when a change is in flight, with a resend button
 *    and a cancel ("this wasn't me") button
 *
 * The cancel action signs out all other sessions to protect against a
 * hijacked session silently taking over the account via the new address.
 */

import { useActionState } from "react";

import {
  cancelEmailChange,
  initiateEmailChange,
} from "./email-change-actions";

export function EmailChangePanel({
  currentEmail,
  hasPendingChange,
}: {
  currentEmail: string;
  /**
   * True when Supabase reports a pending (unconfirmed) email change for the
   * current user — derived server-side from user.new_email being set.
   */
  hasPendingChange: boolean;
}) {
  const [initiateState, initiateAction, isInitiating] = useActionState(
    initiateEmailChange,
    undefined,
  );
  const [cancelState, cancelAction, isCancelling] = useActionState(
    cancelEmailChange,
    undefined,
  );

  return (
    <section aria-labelledby="email-change-heading" className="flex flex-col gap-4">
      <h2
        id="email-change-heading"
        className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
      >
        Email address
      </h2>

      <p className="text-sm text-zinc-950 dark:text-zinc-50">
        Current:{" "}
        <span className="font-medium">{currentEmail}</span>
      </p>

      {hasPendingChange || initiateState?.success ? (
        <div className="rounded-md border border-amber-400/50 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">Email change in progress</p>
          <p className="mt-1">
            Confirmation links have been sent to both your current and new email
            addresses. The change will complete only after both links are
            clicked. Check your inbox — including spam.
          </p>

          <div className="mt-3 flex flex-wrap gap-3">
            {/* Cancel / "this wasn't me" */}
            <form action={cancelAction}>
              <button
                type="submit"
                disabled={isCancelling}
                className="rounded-full border border-red-400 px-4 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500 dark:text-red-300 dark:hover:bg-red-950/30"
              >
                {isCancelling ? "Cancelling…" : "Cancel — this wasn't me"}
              </button>
            </form>
          </div>

          {cancelState?.success ? (
            <p role="status" className="mt-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Email change cancelled. All other sessions have been signed out.
            </p>
          ) : null}
          {cancelState?.error ? (
            <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
              {cancelState.error}
            </p>
          ) : null}
        </div>
      ) : null}

      {!initiateState?.success && !hasPendingChange ? (
        <form action={initiateAction} className="flex flex-col gap-3">
          <div>
            <label
              htmlFor="newEmail"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              New email address
            </label>
            <input
              id="newEmail"
              name="newEmail"
              type="email"
              required
              autoComplete="email"
              placeholder="new@example.com"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
          </div>

          {initiateState?.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {initiateState.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isInitiating}
            className="self-start rounded-full bg-zinc-950 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
          >
            {isInitiating ? "Sending…" : "Change email"}
          </button>

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Confirmation links will be sent to both your current and new
            addresses. You must click both to complete the change. If you
            didn't request this, use the cancel link in the email sent to your
            current address.
          </p>
        </form>
      ) : null}
    </section>
  );
}
