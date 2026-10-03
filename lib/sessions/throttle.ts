/** How often a session's last-seen time may be written (#523). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_MAX_TRACKED_SESSIONS = 10_000;

export interface SessionTouchThrottle {
  /**
   * Returns true when `sessionId` has not been touched within the interval,
   * and records the touch. Returns false otherwise.
   */
  shouldTouch(sessionId: string): boolean;
}

/**
 * Per-instance throttle in front of the touch_my_session() RPC, so most
 * requests from the proxy make no database call at all. It is only an
 * optimization: serverless instances do not share memory, so the
 * authoritative "at most one write per session per five minutes" rule is
 * enforced again inside touch_my_session() itself.
 *
 * The map is bounded; when full, the oldest entry is evicted (Map preserves
 * insertion order and touched keys are re-inserted), so memory stays flat
 * under any number of sessions.
 */
export function createSessionTouchThrottle({
  intervalMs = SESSION_TOUCH_INTERVAL_MS,
  maxEntries = DEFAULT_MAX_TRACKED_SESSIONS,
  now = () => Date.now(),
}: {
  intervalMs?: number;
  maxEntries?: number;
  now?: () => number;
} = {}): SessionTouchThrottle {
  const lastTouched = new Map<string, number>();

  return {
    shouldTouch(sessionId) {
      const current = now();
      const previous = lastTouched.get(sessionId);
      if (previous !== undefined && current - previous < intervalMs) {
        return false;
      }
      lastTouched.delete(sessionId);
      lastTouched.set(sessionId, current);
      if (lastTouched.size > maxEntries) {
        const oldest = lastTouched.keys().next().value;
        if (oldest !== undefined) lastTouched.delete(oldest);
      }
      return true;
    },
  };
}

/**
 * Reads the `session_id` claim from a Supabase access token without
 * verifying it. Use this only as a throttle key or to label the current
 * session in the UI. Authorization never relies on it: touch_my_session()
 * and revoke_my_session() read the session from the JWT that Postgres has
 * already verified.
 */
export function sessionIdFromAccessToken(
  accessToken: string | undefined | null,
): string | null {
  const payload = accessToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { session_id?: unknown };
    return typeof claims.session_id === "string" && claims.session_id
      ? claims.session_id
      : null;
  } catch {
    return null;
  }
}
