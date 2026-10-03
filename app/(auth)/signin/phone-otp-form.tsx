"use client";

/**
 * Issue #530: Phone-number OTP sign-in form.
 *
 * Two-step UI:
 *   Step 1 — Enter phone number → calls sendPhoneOtp server action.
 *   Step 2 — Enter 6-digit code  → calls verifyPhoneOtp server action.
 *
 * The phone number is carried between steps via a hidden <input> in step 2.
 * A resend button (re-submits step 1) is provided with a 60-second countdown
 * to match the max_frequency = "60s" configured in supabase/config.toml.
 */

import { useActionState, useEffect, useRef, useState } from "react";
import { sendPhoneOtp, verifyPhoneOtp } from "./phone-otp-actions";

const RESEND_COOLDOWN_S = 60;

export function PhoneOtpForm() {
  const [sendState, sendAction, isSending] = useActionState(
    sendPhoneOtp,
    undefined,
  );
  const [verifyState, verifyAction, isVerifying] = useActionState(
    verifyPhoneOtp,
    undefined,
  );

  // Countdown for the resend button
  const [countdown, setCountdown] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start the resend countdown whenever an OTP is successfully dispatched.
  useEffect(() => {
    if (!sendState?.sent) return;
    setCountdown(RESEND_COOLDOWN_S);
    intervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [sendState?.sent, sendState?.e164]);

  const otpInputRef = useRef<HTMLInputElement>(null);
  // Auto-focus the OTP input when step 2 appears.
  useEffect(() => {
    if (sendState?.sent) {
      otpInputRef.current?.focus();
    }
  }, [sendState?.sent]);

  // --- Step 2: verify code ---
  if (sendState?.sent && sendState.e164) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          A 6-digit code was sent to{" "}
          <span className="font-medium text-zinc-950 dark:text-zinc-50">
            {sendState.e164}
          </span>
          . Enter it below.
        </p>

        <form action={verifyAction} className="flex flex-col gap-4">
          <input type="hidden" name="e164" value={sendState.e164} />
          <div>
            <label
              htmlFor="otp-token"
              className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              6-digit code
            </label>
            <input
              ref={otpInputRef}
              id="otp-token"
              name="token"
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              placeholder="123456"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 tracking-widest focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
            />
          </div>

          {verifyState?.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {verifyState.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isVerifying}
            className="flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
          >
            {isVerifying ? "Verifying…" : "Verify code"}
          </button>
        </form>

        {/* Resend */}
        <form action={sendAction}>
          <input type="hidden" name="phone" value={sendState.e164} />
          <button
            type="submit"
            disabled={isSending || countdown > 0}
            className="text-sm text-zinc-600 underline underline-offset-2 disabled:no-underline disabled:text-zinc-400 dark:text-zinc-400 dark:disabled:text-zinc-600"
          >
            {countdown > 0
              ? `Resend code in ${countdown}s`
              : isSending
                ? "Sending…"
                : "Resend code"}
          </button>
        </form>
      </div>
    );
  }

  // --- Step 1: enter phone number ---
  return (
    <form action={sendAction} className="flex flex-col gap-4">
      <div>
        <label
          htmlFor="phone-number"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Phone number
        </label>
        <input
          id="phone-number"
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          placeholder="+2348001234567"
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Nigerian numbers only. Enter with or without the +234 prefix.
        </p>
      </div>

      {sendState?.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {sendState.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={isSending}
        className="flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
      >
        {isSending ? "Sending code…" : "Send code"}
      </button>
    </form>
  );
}
