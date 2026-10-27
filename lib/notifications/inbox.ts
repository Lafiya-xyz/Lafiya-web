/**
 * Issue #764: in-app notification inbox.
 *
 * Persisted rows carry only a fixed event type and a localization key
 * (never rendered text or PHI). Writes are idempotent per event key, so an
 * outbox retry cannot create a duplicate row.
 */

export const INBOX_NOTIFICATION_TYPES = [
  "new_sign_in",
  "mfa_change",
  "data_export",
  "card_rotation",
  "break_glass_access",
] as const;

export type InboxNotificationType = (typeof INBOX_NOTIFICATION_TYPES)[number];

export const INBOX_RETENTION_DAYS = 180;

export type InboxNotification = {
  id: string;
  type: InboxNotificationType;
  body_key: string;
  created_at: string;
  read_at: string | null;
};

export type InboxPayload = {
  event_key: string;
  type: InboxNotificationType;
  body_key: string;
  card_public_id: string;
};

const BODY_KEY = /^[a-z0-9_.]{1,100}$/;

/** Validates an outbox payload; returns null when it is not a safe inbox row. */
export function parseInboxPayload(
  payload: Record<string, unknown>,
): InboxPayload | null {
  const { event_key, type, body_key, card_public_id } = payload;
  if (
    typeof event_key !== "string" ||
    event_key.length === 0 ||
    event_key.length > 200
  ) {
    return null;
  }
  if (!INBOX_NOTIFICATION_TYPES.includes(type as InboxNotificationType))
    return null;
  if (typeof body_key !== "string" || !BODY_KEY.test(body_key)) return null;
  if (typeof card_public_id !== "string" || card_public_id.length === 0)
    return null;
  return {
    event_key,
    type: type as InboxNotificationType,
    body_key,
    card_public_id,
  };
}

/** English fallbacks for body keys; never interpolates user data. */
export const INBOX_MESSAGES: Record<InboxNotificationType, string> = {
  new_sign_in: "A new sign-in to your account was detected.",
  mfa_change: "Your two-factor authentication settings changed.",
  data_export: "A copy of your data was exported.",
  card_rotation: "Your emergency card link was rotated.",
  break_glass_access: "Your emergency card was accessed in an emergency.",
};

export function unreadCount(items: readonly InboxNotification[]): number {
  return items.filter((item) => item.read_at === null).length;
}

/** Merges a realtime insert/update into the list, newest first, without duplicates. */
export function upsertNotification(
  items: readonly InboxNotification[],
  next: InboxNotification,
): InboxNotification[] {
  const rest = items.filter((item) => item.id !== next.id);
  return [next, ...rest].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}
