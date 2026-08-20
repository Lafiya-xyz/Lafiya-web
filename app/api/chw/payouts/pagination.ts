/**
 * Opaque cursor encoding for the CHW payout history API.
 *
 * Payouts are paginated by the (created_at, id) tuple of the last row on
 * the previous page, ordered DESC. Wrapping the tuple in base64url(JSON):
 *
 *   - keeps cursors opaque to clients (no leaked timestamps / UUIDs),
 *   - gives one canonical wire format that's URL-safe (with no padding
 *     so it doesn't need encoding inside other query strings),
 *   - lets us validate cursors defensively before using them in SQL:
 *     a tampered, stale, or truncated cursor fails decode and turns
 *     into a 400, never an unbounded scan or wrong-page result.
 *
 * Decoder NEVER trusts the cursor contents. Treat them as untrusted
 * input: a valid base64url + valid JSON shape is the *upper* bound on
 * what we'll accept, not a guarantee of correctness.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export interface PayoutCursor {
  /** ISO-8601 timestamp of the last row on the previous page. */
  readonly c: string;
  /** UUID id of the last row on the previous page. */
  readonly i: string;
}

export class InvalidCursorError extends Error {
  override name = "InvalidCursorError";
}

/** Encode a (created_at, id) tuple as a base64url cursor. */
export function encodePayoutCursor(
  createdAt: string,
  id: string,
): string {
  if (!ISO_REGEX.test(createdAt)) {
    throw new InvalidCursorError("createdAt must be an ISO-8601 string");
  }
  if (!UUID_REGEX.test(id)) {
    throw new InvalidCursorError("id must be a UUID");
  }
  const payload: PayoutCursor = { c: createdAt, i: id };
  const json = JSON.stringify(payload);
  return base64UrlEncode(json);
}

/**
 * Decode a base64url cursor back to its (created_at, id) tuple, or
 * throw InvalidCursorError on any malformed input. The router turns
 * this into a 400 — clients only learn that the cursor is rejected,
 * never why, so probing for a useful cursor format is pointless.
 */
export function decodePayoutCursor(cursor: string): PayoutCursor {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512) {
    throw new InvalidCursorError();
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidCursorError();
  }
  let raw: string;
  try {
    raw = base64UrlDecode(cursor);
  } catch {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCursorError();
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new InvalidCursorError();
  }
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== "string" || typeof i !== "string") {
    throw new InvalidCursorError();
  }
  if (!ISO_REGEX.test(c) || !UUID_REGEX.test(i)) {
    throw new InvalidCursorError();
  }
  return { c, i };
}

function base64UrlEncode(input: string): string {
  if (typeof btoa === "function") {
    return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  if (typeof atob === "function") {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (padded.length % 4)) % 4;
    return atob(padded + "=".repeat(padding));
  }
  return Buffer.from(input, "base64").toString("utf8");
}
