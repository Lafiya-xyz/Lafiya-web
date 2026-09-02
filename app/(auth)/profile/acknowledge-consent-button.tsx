"use client";

import { useState, useTransition } from "react";
import { acknowledgeCurrentPolicy } from "./consent/actions";

/**
 * Client button that calls the `acknowledgeCurrentPolicy` server action.
 * Surfaces an inline status message and disables itself once acknowledged.
 */
export function AcknowledgeConsentButton() {
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "done" | "already" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  function handleClick() {
    startTransition(async () => {
      const result = await acknowledgeCurrentPolicy();
      if (result.status === "acknowledged") {
        setStatus("done");
        setMessage("Thank you — your acknowledgement has been recorded.");
      } else if (result.status === "already_acknowledged") {
        setStatus("already");
        setMessage("You have already acknowledged the current policy.");
      } else {
        setStatus("error");
        setMessage(result.error ?? "Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending || status === "done"}
        className="min-h-11 w-fit rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:focus:ring-zinc-600"
      >
        {pending
          ? "Saving…"
          : status === "done"
            ? "Acknowledged"
            : "Acknowledge current policy"}
      </button>
      {message ? (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
