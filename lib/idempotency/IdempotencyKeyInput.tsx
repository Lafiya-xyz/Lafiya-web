/**
 * Hidden form input that supplies a per-render idempotency UUID (issue #626).
 *
 * Drop this inside any form that wraps a destructive Server Action:
 *
 * ```tsx
 * <form action={formAction}>
 *   <IdempotencyKeyInput />
 *   <button type="submit">Regenerate</button>
 * </form>
 * ```
 *
 * `IdempotencyKeyInput` is a Server Component — the UUID is generated during
 * SSR so the form works without client JavaScript.
 *
 * `IdempotencyKeyInputClient` is a Client Component variant for forms that
 * are fully client-rendered (e.g. inside a `"use client"` component tree).
 * It initialises the UUID once per mount using `useId`-seeded `crypto.randomUUID`.
 *
 * Privacy: the UUID is opaque and carries no PHI or user-identifying data.
 */

import { randomUUID } from "node:crypto";

/** Server Component variant — UUID generated at SSR time. */
export function IdempotencyKeyInput() {
  const id = randomUUID();
  return <input type="hidden" name="idempotencyKey" value={id} />;
}
