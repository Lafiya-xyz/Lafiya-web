"use client";

/**
 * Client Component variant of IdempotencyKeyInput (issue #626).
 *
 * Use this inside `"use client"` component trees (e.g. dialogs, modals)
 * where Server Components cannot be rendered.  The UUID is generated once
 * per mount via `useState(() => crypto.randomUUID())`.
 *
 * The value is stable for the lifetime of the component: re-renders (e.g.
 * isPending state changes) do not produce a new key, preserving idempotency
 * for the current form submission.
 *
 * Privacy: the UUID is opaque and carries no PHI or user-identifying data.
 */

import { useState } from "react";

export function IdempotencyKeyInputClient() {
  // Initialise once; stable across re-renders.
  const [id] = useState(() => crypto.randomUUID());
  return <input type="hidden" name="idempotencyKey" value={id} />;
}
