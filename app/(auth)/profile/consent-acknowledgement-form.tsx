"use client";

import { useActionState } from "react";

import { CURRENT_POLICY_VERSION } from "@/lib/consent/policy";

import { acknowledgeCurrentPolicy } from "./actions";

export function ConsentAcknowledgementForm() {
  const [state, formAction, isPending] = useActionState(
    acknowledgeCurrentPolicy,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col items-start gap-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Review the current policy before acknowledging version{" "}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {CURRENT_POLICY_VERSION}
        </span>
        .
      </p>
      <a
        href="/privacy"
        className="text-sm font-medium text-emerald-700 underline underline-offset-4 dark:text-emerald-400"
      >
        Read the privacy policy
      </a>
      {state?.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state?.success ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          Policy acknowledgement recorded.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={isPending}
        className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 dark:bg-emerald-600"
      >
        {isPending ? "Recording..." : "Acknowledge current policy"}
      </button>
    </form>
  );
}
