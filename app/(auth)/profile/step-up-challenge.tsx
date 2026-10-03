"use client";

import { useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Issue #522: mounted (only) by any of the four high-impact-action paths
 * (delete account, regenerate card id, repair verification secret, export
 * data) when their server action/route reports STEP_UP_REQUIRED, so it
 * never sits in the DOM as an extra closed <dialog> the rest of the time.
 *
 * Verifying the TOTP code here elevates the *session itself* to aal2 (via
 * Supabase's own challengeAndVerify) -- once that succeeds, the caller's
 * `onVerified` decides what to do next (resubmit its form, or navigate),
 * so this never re-implements whatever the original action does. Form
 * callers resubmit the same form element, so nothing the user already
 * typed (e.g. the typed "DELETE" confirmation) needs to be re-entered.
 */
export function StepUpChallenge({
  onVerified,
  onCancel,
}: {
  onVerified: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // dialog.close() always fires the native "close" event, whether we closed
  // it because verification succeeded or because the user cancelled -- this
  // flag lets the single onClose handler below tell those two cases apart
  // instead of firing onCancel right after a successful onVerified.
  const suppressNextCloseRef = useRef(false);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  function handleCancelClick() {
    setCode("");
    setError(null);
    dialogRef.current?.close();
  }

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setVerifying(true);
    try {
      const supabase = createClient();
      const { data: factorsData, error: factorsError } =
        await supabase.auth.mfa.listFactors();
      const factor = factorsData?.totp.find((f) => f.status === "verified");
      if (factorsError || !factor) {
        setError("No verified authenticator app is enrolled on this account.");
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: factor.id,
        code,
      });
      if (verifyError) {
        setError("That code didn't work. Check your authenticator app and try again.");
        return;
      }

      setCode("");
      suppressNextCloseRef.current = true;
      dialogRef.current?.close();
      onVerified();
    } finally {
      setVerifying(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={() => {
        if (suppressNextCloseRef.current) {
          suppressNextCloseRef.current = false;
          return;
        }
        onCancel();
      }}
      className="w-full max-w-sm rounded-xl border border-zinc-300 bg-white p-6 text-zinc-950 backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
    >
      <form onSubmit={handleVerify}>
        <h2 className="text-lg font-semibold">Verify it&apos;s you</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          This action needs an extra check. Enter the 6-digit code from your
          authenticator app.
        </p>

        <label htmlFor="step-up-code" className="sr-only">
          Authentication code
        </label>
        <input
          id="step-up-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          className="mt-4 w-full rounded-md border border-zinc-300 px-3 py-2 text-center text-lg tracking-widest text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />

        {error ? (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleCancelClick}
            className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={verifying || code.length !== 6}
            className="min-h-11 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {verifying ? "Verifying…" : "Verify"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
