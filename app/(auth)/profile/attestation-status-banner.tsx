"use client";

import { useActionState } from "react";

import { requestReattestation } from "./actions";

/**
 * Shown on /profile only when the patient's profile has been edited since
 * the last time their card was observed to have a valid on-chain
 * attestation (see the staleness check in page.tsx). Kept as a sibling of
 * ProfileForm, not a prop on it, so ProfileForm's existing contract/tests
 * stay untouched.
 */
export function AttestationStatusBanner({
  pendingRequestExists,
}: {
  pendingRequestExists: boolean;
}) {
  const [state, formAction, isPending] = useActionState(
    requestReattestation,
    undefined,
  );

  const requested = pendingRequestExists || state?.success === true;

  return (
    <div
      role="status"
      className="rounded-md border border-amber-500/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <p className="font-medium">Profile edited since last verification</p>
      <p className="mt-1">
        Your card&apos;s emergency details have changed since a health worker
        last verified it. Responders scanning your QR code will see &quot;not
        verified&quot; until it&apos;s re-verified.
      </p>

      {state?.error ? (
        <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="mt-3">
        <button
          type="submit"
          disabled={isPending || requested}
          className="rounded-full border border-amber-600 px-4 py-2 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-400 dark:text-amber-100 dark:hover:bg-amber-900/40"
        >
          {requested
            ? "Re-verification requested"
            : isPending
              ? "Requesting…"
              : "Request re-verification"}
        </button>
      </form>
    </div>
  );
}
