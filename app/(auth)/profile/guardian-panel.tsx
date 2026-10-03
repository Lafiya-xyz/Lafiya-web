"use client";

/**
 * Issue #531: Guardian panel — lists dependant profiles and allows
 * the guardian to create, edit, or delete each one (max 5).
 *
 * Also acts as the profile switcher: each dependant card has a
 * "View card" link that opens the public card URL for that dependant.
 */

import { useState } from "react";
import { useActionState } from "react";

import type { DependantRow } from "@/lib/supabase/types";
import { deleteDependant } from "./guardian-actions";
import { DependantForm } from "./dependant-form";

function DependantCard({
  dependant,
  baseUrl,
}: {
  dependant: DependantRow;
  baseUrl: string;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteState, deleteAction, isDeleting] = useActionState(
    deleteDependant,
    undefined,
  );

  if (editing) {
    return (
      <li className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <DependantForm dependant={dependant} onCancel={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-zinc-950 dark:text-zinc-50">
            {dependant.name}
          </p>
          {dependant.date_of_birth ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              DOB: {dependant.date_of_birth}
            </p>
          ) : null}
          {dependant.language ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Language: {dependant.language}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <a
            href={`${baseUrl}/card/${dependant.card_public_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            View card
          </a>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-full border border-red-300 px-3 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirming ? (
        <form action={deleteAction} className="mt-4 flex flex-col gap-2">
          <input type="hidden" name="dependantId" value={dependant.id} />
          <p className="text-sm text-red-700 dark:text-red-400">
            Type <strong>DELETE</strong> to permanently remove this profile.
          </p>
          <input
            name="confirm"
            type="text"
            required
            placeholder="DELETE"
            autoComplete="off"
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-zinc-950 focus:ring-2 focus:ring-red-400 focus:ring-offset-0 focus:outline-none dark:border-red-800 dark:bg-zinc-900 dark:text-zinc-50"
          />
          {deleteState?.error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {deleteState.error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isDeleting}
              className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {isDeleting ? "Removing…" : "Remove profile"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export function GuardianPanel({
  dependants,
  baseUrl,
}: {
  dependants: DependantRow[];
  baseUrl: string;
}) {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const canAddMore = dependants.length < 5;

  return (
    <section aria-labelledby="guardian-panel-heading" className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2
          id="guardian-panel-heading"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Dependant profiles
        </h2>
        {canAddMore && !showCreateForm ? (
          <button
            type="button"
            onClick={() => setShowCreateForm(true)}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            + Add dependant
          </button>
        ) : null}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {dependants.length}/5 dependant profile{dependants.length !== 1 ? "s" : ""} used.
        A guardian can manage up to 5.
      </p>

      {dependants.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Dependant profiles">
          {dependants.map((dep) => (
            <DependantCard key={dep.id} dependant={dep} baseUrl={baseUrl} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No dependant profiles yet. Add one to manage a child or dependent&apos;s card.
        </p>
      )}

      {showCreateForm ? (
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h3 className="mb-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            New dependant profile
          </h3>
          <DependantForm onCancel={() => setShowCreateForm(false)} />
        </div>
      ) : null}
    </section>
  );
}
