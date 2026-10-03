"use client";

/**
 * Issue #531: Form to create or update a single dependant profile.
 * Used by the GuardianPanel.
 */

import { useActionState } from "react";
import { createDependant, updateDependant } from "./guardian-actions";
import type { DependantRow } from "@/lib/supabase/types";

export function DependantForm({
  dependant,
  onCancel,
}: {
  dependant?: DependantRow;
  onCancel?: () => void;
}) {
  const action = dependant ? updateDependant : createDependant;
  const [state, formAction, isPending] = useActionState(action, undefined);

  const isEdit = !!dependant;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {isEdit ? (
        <input type="hidden" name="dependantId" value={dependant.id} />
      ) : null}

      {state?.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state?.success ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {isEdit ? "Changes saved." : "Dependant profile created."}
        </p>
      ) : null}

      <div>
        <label
          htmlFor="dep-name"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Full name <span aria-hidden="true" className="text-red-500">*</span>
        </label>
        <input
          id="dep-name"
          name="name"
          type="text"
          required
          defaultValue={dependant?.name ?? ""}
          aria-invalid={state?.errors?.name ? "true" : undefined}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
        {state?.errors?.name ? (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">
            {state.errors.name}
          </p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor="dep-dob"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Date of birth
        </label>
        <input
          id="dep-dob"
          name="dateOfBirth"
          type="date"
          defaultValue={dependant?.date_of_birth ?? ""}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
      </div>

      <div>
        <label
          htmlFor="dep-language"
          className="block text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Language spoken
        </label>
        <input
          id="dep-language"
          name="language"
          type="text"
          placeholder="e.g. Hausa"
          defaultValue={dependant?.language ?? ""}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-zinc-950 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:ring-zinc-600"
        />
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full bg-zinc-950 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
        >
          {isPending ? "Saving…" : isEdit ? "Save changes" : "Create profile"}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-zinc-300 px-5 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
