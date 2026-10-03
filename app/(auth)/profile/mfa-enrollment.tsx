"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type EnrollmentState =
  | { step: "loading" }
  | { step: "disabled" }
  | { step: "enabled"; factorId: string }
  | { step: "enrolling"; factorId: string; qrCode: string; secret: string }
  | { step: "error"; message: string };

/**
 * Issue #522: lets a patient enroll (or remove) the TOTP factor that the
 * step-up guard in lib/auth/assurance.ts checks for. A user who never
 * enrolls here is unaffected by that guard -- needsStepUp() only blocks
 * when a verified factor already exists (nextLevel === "aal2").
 */
export function MfaEnrollment() {
  const [state, setState] = useState<EnrollmentState>({ step: "loading" });
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) {
      setState({
        step: "error",
        message: "Could not load your two-factor authentication status.",
      });
      return;
    }
    const factor = data.totp.find((f) => f.status === "verified");
    setState(factor ? { step: "enabled", factorId: factor.id } : { step: "disabled" });
  }

  async function startEnrollment() {
    setState({ step: "loading" });
    const supabase = createClient();
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
    });
    if (error || !data) {
      setState({
        step: "error",
        message: "Could not start two-factor setup. Please try again.",
      });
      return;
    }
    setState({
      step: "enrolling",
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
  }

  async function cancelEnrollment(factorId: string) {
    const supabase = createClient();
    // The factor is still unverified at this point -- remove it rather than
    // leaving an abandoned factor behind.
    await supabase.auth.mfa.unenroll({ factorId });
    setCode("");
    setVerifyError(null);
    setState({ step: "disabled" });
  }

  async function verifyEnrollment(factorId: string) {
    setVerifyError(null);
    setVerifying(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId,
        code,
      });
      if (error) {
        setVerifyError(
          "That code didn't work. Check your authenticator app and try again.",
        );
        return;
      }
      setCode("");
      await refresh();
    } finally {
      setVerifying(false);
    }
  }

  async function disableMfa(factorId: string) {
    setConfirmingDisable(false);
    setState({ step: "loading" });
    const supabase = createClient();
    await supabase.auth.mfa.unenroll({ factorId });
    await refresh();
  }

  if (state.step === "loading") {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-500">
        Loading two-factor authentication status…
      </p>
    );
  }

  if (state.step === "error") {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {state.message}
      </p>
    );
  }

  if (state.step === "enabled") {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
              Two-factor authentication is on
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              You&apos;ll be asked for a code from your authenticator app
              before exporting your data, deleting your account, or making
              other sensitive changes.
            </p>
          </div>
          {!confirmingDisable ? (
            <button
              type="button"
              onClick={() => setConfirmingDisable(true)}
              className="min-h-11 shrink-0 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
            >
              Turn off
            </button>
          ) : null}
        </div>

        {confirmingDisable ? (
          <div className="flex items-center justify-between gap-4 rounded-md border border-amber-500/40 bg-amber-50 p-3 dark:border-amber-400/40 dark:bg-amber-950/30">
            <p className="text-sm text-amber-900 dark:text-amber-100">
              Turning this off removes the extra check on your sensitive
              actions.
            </p>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => setConfirmingDisable(false)}
                className="min-h-11 rounded-full border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => disableMfa(state.factorId)}
                className="min-h-11 rounded-full bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus:ring-2 focus:ring-red-400 focus:ring-offset-0 focus:outline-none dark:focus:ring-red-600"
              >
                Turn off
              </button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (state.step === "enrolling") {
    return (
      <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
          Scan this QR code with your authenticator app
        </p>
        {/* Issue #520/#522 note: this SVG data URI is generated by Supabase
            from the per-user TOTP secret and never leaves the browser --
            it is not fetched from, or sent to, any third party. next/image
            doesn't optimize data: URLs, so a plain <img> is used here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={state.qrCode}
          alt="Two-factor authentication QR code"
          className="h-40 w-40 self-center"
        />
        <p className="text-center text-xs text-zinc-500 dark:text-zinc-500">
          Can&apos;t scan it? Enter this code manually:{" "}
          <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono dark:bg-zinc-800">
            {state.secret}
          </code>
        </p>

        <div>
          <label
            htmlFor="mfa-enroll-code"
            className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
          >
            Enter the 6-digit code from your app
          </label>
          <input
            id="mfa-enroll-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, ""))
            }
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-center text-lg tracking-widest text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
          />
        </div>

        {verifyError ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {verifyError}
          </p>
        ) : null}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => cancelEnrollment(state.factorId)}
            className="min-h-11 flex-1 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={verifying || code.length !== 6}
            onClick={() => verifyEnrollment(state.factorId)}
            className="min-h-11 flex-1 rounded-full bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            {verifying ? "Verifying…" : "Verify and enable"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div>
        <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
          Two-factor authentication is off
        </p>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Add an authenticator app for an extra check before exporting your
          data, deleting your account, or making other sensitive changes.
        </p>
      </div>
      <button
        type="button"
        onClick={startEnrollment}
        className="min-h-11 shrink-0 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
      >
        Set up
      </button>
    </div>
  );
}
