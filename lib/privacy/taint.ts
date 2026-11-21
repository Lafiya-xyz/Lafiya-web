/**
 * Issue #959: server-to-client PHI boundary guards.
 *
 * React's taint APIs mark server-only values so that passing them into a
 * Client Component (or serializing them into a Server Action response)
 * throws instead of silently shipping PHI to the browser. They are no-ops
 * outside a React Server Component render, so this module is safe to import
 * from route handlers, tests and scripts.
 *
 * Usage: call `taintProfileRow(row)` at the load site (right after the
 * Supabase query) and hand Client Components an explicit DTO built by a
 * mapper in `lib/privacy/dto.ts` instead of the row itself.
 */
import { taintObjectReference, taintUniqueValue } from "react";

const TAINT_MESSAGE =
  "PHI boundary violation: a raw server object was passed to a Client Component. Map it to a DTO first (see lib/privacy/dto.ts).";

/**
 * Marks a raw `profiles` row as server-only. Any attempt to pass the row
 * (or an object reachable from it) to a Client Component throws in dev and
 * test.
 */
export function taintProfileRow<T extends object>(row: T): T {
  taintObjectReference(TAINT_MESSAGE, row);
  return row;
}

/**
 * Marks a secret string (record secret, service token, capability token) as
 * server-only. `taintUniqueValue` throws if the exact value is serialized to
 * the client, even when nested inside an otherwise-safe DTO.
 */
export function taintSecret<T extends string>(value: T): T {
  taintUniqueValue(TAINT_MESSAGE, {}, value);
  return value;
}
