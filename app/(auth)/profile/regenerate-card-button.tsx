"use client";

import { useActionState, useRef } from "react";

import { regenerateCardId } from "./actions";

export function RegenerateCardButton() {
  const [state, formAction, isPending] = useActionState(
    regenerateCardId,
    undefined,
  );
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => dialogRef.current?.showModal()}
        className="min-h-11 rounded-full border border-red-300 px-4 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
      >
        Regenerate QR code
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-sm rounded-xl border border-zinc-300 bg-white p-6 text-zinc-950 backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      >
        <form action={formAction}>
          <h2 className="text-lg font-semibold">Regenerate QR code?</h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            This will immediately invalidate your current QR code and card link.
            Any printed cards or saved links will stop working. This action
            cannot be undone.
          </p>

          {state?.error ? (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">
              {state.error}
            </p>
          ) : null}

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="min-h-11 rounded-full bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
            >
              {isPending ? "Regenerating…" : "Regenerate"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
