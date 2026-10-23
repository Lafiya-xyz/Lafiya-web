/**
 * PHI-safe error sanitization for the transactional outbox (issue #688).
 *
 * `outbox.last_error` is read by operators and may be included in readiness
 * output, so it must never contain payloads, identifiers, capability tokens,
 * credentials, or stack frames.  Only the top-level message is retained and
 * the shared logger redactor strips known sensitive patterns.
 */

import { redactString } from "@/lib/logging/logger";

export const MAX_OUTBOX_LAST_ERROR_LENGTH = 500;

export function sanitizeOutboxError(error: unknown): string {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "outbox handler failed";

  const redacted = redactString(rawMessage)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const safe = redacted || "outbox handler failed";
  return safe.slice(0, MAX_OUTBOX_LAST_ERROR_LENGTH);
}
