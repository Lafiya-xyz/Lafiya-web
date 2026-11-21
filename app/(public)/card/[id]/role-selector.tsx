"use client";

import { useEffect, useState } from "react";

import {
  CARD_ROLES,
  CARD_ROLE_LABELS,
  CARD_ROLE_STORAGE_KEY,
  DEFAULT_CARD_ROLE,
  resolveCardRole,
  type CardRole,
} from "@/lib/clinical/card-role-layout";

/**
 * Issue #921: role selector for the public card view.
 *
 * The choice is stored in localStorage only — it never leaves the device, so
 * it keeps working offline and carries no PHI. The card renders the default
 * role on the server and swaps to the stored role after hydration, which
 * keeps the route static-friendly and avoids a hydration mismatch.
 */
export function RoleSelector({
  onRoleChange,
}: {
  onRoleChange: (role: CardRole) => void;
}) {
  const [role, setRole] = useState<CardRole>(DEFAULT_CARD_ROLE);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(CARD_ROLE_STORAGE_KEY);
    } catch {
      // Storage can be unavailable (private mode, disabled cookies); the
      // selector still works for this page view.
    }
    const resolved = resolveCardRole(stored);
    setRole(resolved);
    onRoleChange(resolved);
  }, [onRoleChange]);

  function select(next: CardRole) {
    setRole(next);
    onRoleChange(next);
    try {
      window.localStorage.setItem(CARD_ROLE_STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-memory choice still applies.
    }
  }

  return (
    <fieldset
      data-testid="card-role-selector"
      className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700"
    >
      <legend className="px-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
        View as
      </legend>
      <div className="mt-2 flex flex-wrap gap-2">
        {CARD_ROLES.map((option) => (
          <label
            key={option}
            className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium ${
              role === option
                ? "border-zinc-950 bg-zinc-950 text-zinc-50 dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-950"
                : "border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            }`}
          >
            <input
              type="radio"
              name="card-role"
              value={option}
              checked={role === option}
              onChange={() => select(option)}
              className="sr-only"
            />
            {CARD_ROLE_LABELS[option]}
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
        Reorders the card for your role. All fields stay visible, and your
        choice is saved on this device only.
      </p>
    </fieldset>
  );
}
