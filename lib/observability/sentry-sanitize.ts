/**
 * Allowlist-based PHI scrubber for Sentry events.
 *
 * Denylist scrubbing misses new fields, so we invert the model: only keys that
 * are known-safe survive sanitization. Everything else is dropped. This module
 * is shared by the client, server, and edge Sentry configs so all runtimes
 * apply identical privacy rules.
 *
 * Privacy decisions:
 * - Capability tokens embedded in `/card/...` URL segments are replaced with
 *   `[capability]` so they never reach a third party.
 * - Request bodies (`event.request.data`) and cookies are always dropped.
 * - `extra` and `contexts` are filtered through a key allowlist.
 * - Messages are truncated to a bounded length.
 */

/** Keys that are safe to forward to Sentry in `extra` and `contexts`. */
export const SAFE_KEYS: ReadonlySet<string> = new Set([
  "environment",
  "release",
  "dist",
  "transaction",
  "logger",
  "level",
  "platform",
  "sdk",
  "runtime",
  "os",
  "browser",
  "device",
  "app",
  "trace",
  "span",
  "request_id",
  "correlation_id",
  "route",
  "method",
  "status_code",
  "duration_ms",
  "component",
  "module",
  "error_type",
  "error_code",
]);

/** Maximum length for any forwarded message string. */
export const MAX_MESSAGE_LENGTH = 512;

const CAPABILITY_SEGMENT = /\/card\/[^/?#]+/gi;

/** Replace capability tokens in a URL with a stable placeholder. */
export function redactUrl(url: unknown): unknown {
  if (typeof url !== "string") return url;
  return url.replace(CAPABILITY_SEGMENT, "/card/[capability]");
}

/** Truncate a message to a bounded length. */
export function truncateMessage(message: unknown): unknown {
  if (typeof message !== "string") return message;
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
}

/** Keep only allowlisted keys from a record. */
function allowlistKeys<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (SAFE_KEYS.has(key)) {
      result[key] = source[key];
    }
  }
  return result as T;
}

/** Sanitize a Sentry request object in place-safe fashion. */
function sanitizeRequest(request: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...request };
  if ("url" in sanitized) {
    sanitized.url = redactUrl(sanitized.url);
  }
  // Never forward request bodies or cookies.
  delete sanitized.data;
  delete sanitized.cookies;
  return sanitized;
}

/** Sanitize a breadcrumb, redacting URLs and truncating messages. */
export function sanitizeBreadcrumb<T>(breadcrumb: T): T {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  const source = breadcrumb as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };

  if ("message" in result) {
    result.message = truncateMessage(result.message);
  }

  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    const data = { ...(result.data as Record<string, unknown>) };
    if ("url" in data) {
      data.url = redactUrl(data.url);
    }
    result.data = allowlistKeys(data);
  }

  return result as T;
}

/**
 * Sanitize any Sentry event (error or transaction) using the allowlist model.
 * Safe to call from `beforeSend` in every runtime.
 */
export function sanitizeEvent<T>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const source = event as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };

  if ("message" in result) {
    result.message = truncateMessage(result.message);
  }

  if (result.request && typeof result.request === "object" && !Array.isArray(result.request)) {
    result.request = sanitizeRequest(result.request as Record<string, unknown>);
  }

  if (result.extra && typeof result.extra === "object" && !Array.isArray(result.extra)) {
    result.extra = allowlistKeys(result.extra);
  }

  if (result.contexts && typeof result.contexts === "object" && !Array.isArray(result.contexts)) {
    result.contexts = allowlistKeys(result.contexts);
  }

  if (Array.isArray(result.breadcrumbs)) {
    result.breadcrumbs = result.breadcrumbs.map((breadcrumb) => sanitizeBreadcrumb(breadcrumb));
  }

  return result as T;
}
