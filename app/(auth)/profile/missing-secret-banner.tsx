"use client";

import { useActionState } from "react";

import { repairProfileSecret } from "./actions";

/**
 * Shown on /profile when the patient's profile exists but the per-patient
 * HMAC secret (profile_secrets row) was never provisioned — typically
 * because ensureRecordSecret failed transiently after the profile save
 * succeeded. The banner provides an actionable retry path that calls
 * the idempotent repairProfileSecret server action.
 */
export function MissingSecretBanner() {
  const [state, formAction, isPending] = useActionState(
    async () => repairProfileSecret(),
    undefined,
  );

  const repaired =
    state?.status === "already_ok" || state?.status === "repaired";

  return (
    <div
      role="status"
      className="rounded-md border border-amber-500/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <p className="font-medium">Verification setup needs repair</p>
      <p className="mt-1">
        Your profile is saved but the verification secret needed to check your
        card&apos;s authenticity was not created. Card verification is
        unavailable until this is repaired.
      </p>

      {state?.status === "error" ? (
        <p role="alert" className="mt-2 text-red-700 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="mt-3">
        <button
          type="submit"
          disabled={isPending || repaired}
          className="rounded-full border border-amber-600 px-4 py-2 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50 dark:border-amber-400 dark:text-amber-100 dark:hover:bg-amber-900/40"
        >
          {repaired
            ? "Verification repaired"
            : isPending
              ? "Repairing…"
              : "Repair verification setup"}
        </button>
      </form>
    </div>
  );
}
