"use client";

import { useActionState, useState } from "react";

import { deleteAccount } from "./actions";

export function DeleteAccountButton() {
  const [state, formAction, isPending] = useActionState(
    deleteAccount,
    undefined,
  );
  const [step, setStep] = useState<"idle" | "confirm">("idle");

  if (step === "idle") {
    return (
      <button
        type="button"
        onClick={() => setStep("confirm")}
        className="flex h-11 items-center justify-center rounded-full border border-red-300 px-6 text-base font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
      >
        Delete account
      </button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm font-medium text-red-800 dark:text-red-200">
          This will permanently delete your Lafiya card and all your data. Your
          emergency card URL will stop working immediately. This action cannot
          be undone.
        </p>
      </div>

      <div>
        <label
          htmlFor="confirm"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Type{" "}
          <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 font-mono text-xs dark:border-zinc-600">
            DELETE
          </kbd>{" "}
          to confirm
        </label>
        <input
          id="confirm"
          name="confirm"
          type="text"
          autoComplete="off"
          required
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
        />
      </div>

      {state?.error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{state.error}</p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setStep("idle")}
          className="flex h-11 flex-1 items-center justify-center rounded-full border border-zinc-300 px-6 text-base font-medium text-zinc-950 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending}
          className="flex h-11 flex-1 items-center justify-center rounded-full bg-red-600 px-6 text-base font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {isPending ? "Deleting…" : "Permanently delete"}
        </button>
      </div>
    </form>
  );
}
