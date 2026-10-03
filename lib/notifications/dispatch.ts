import { createHash } from "crypto";

/**
 * Security-relevant account events that patients must be notified about.
 *
 * Templates intentionally contain ONLY the event type, a coarse time bucket,
 * and a device family. No PHI (names, emails, IPs, tokens, health data) is
 * ever placed into a notification payload.
 */
export type SecurityEventType =
  | "new_sign_in"
  | "mfa_change"
  | "data_export"
  | "card_rotation";

export type DeviceFamily = "desktop" | "mobile" | "tablet" | "unknown";

/** Coarse time bucket — never an exact timestamp. */
export type CoarseTime = "today" | "yesterday" | "this_week" | "earlier";

export interface SecurityEvent {
  type: SecurityEventType;
  /** Stable id used for idempotent dispatch (e.g. sign-in id, export id). */
  eventId: string;
  /** Account the notification is addressed to. */
  userId: string;
  occurredAt: Date;
  deviceFamily?: DeviceFamily;
}

export interface RenderedNotification {
  eventType: SecurityEventType;
  coarseTime: CoarseTime;
  deviceFamily: DeviceFamily;
  subject: string;
  body: string;
}

/**
 * Critical security events are non-optional and cannot be disabled by user
 * preferences. Everything else can be opted out of.
 */
export const CRITICAL_EVENTS: ReadonlySet<SecurityEventType> = new Set([
  "new_sign_in",
  "mfa_change",
  "data_export",
  "card_rotation",
]);

export interface NotificationPreferences {
  /** Event types the user has explicitly disabled. */
  disabled?: Partial<Record<SecurityEventType, boolean>>;
}

/**
 * Notification transport abstraction. Implementations may send email, write to
 * a local mailbox for tests, etc. Kept minimal so actions stay fast and the
 * outbox owns delivery.
 */
export interface NotificationTransport {
  send(notification: RenderedNotification & { userId: string }): Promise<void>;
}

/**
 * Outbox abstraction. Enqueue is fast and non-blocking; a worker drains the
 * outbox and calls the transport. Enqueue must be idempotent per eventId.
 */
export interface NotificationOutbox {
  enqueue(entry: {
    idempotencyKey: string;
    userId: string;
    eventType: SecurityEventType;
    coarseTime: CoarseTime;
    deviceFamily: DeviceFamily;
  }): Promise<void>;
}

const DEVICE_FAMILIES: ReadonlySet<DeviceFamily> = new Set([
  "desktop",
  "mobile",
  "tablet",
  "unknown",
]);

/**
 * Reduce a precise timestamp to a coarse bucket so notifications never leak
 * exact activity times.
 */
export function toCoarseTime(occurredAt: Date, now: Date = new Date()): CoarseTime {
  const msPerDay = 24 * 60 * 60 * 1000;
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const diffDays = Math.floor((startOfToday - occurredAt.getTime()) / msPerDay);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays <= 7) return "this_week";
  return "earlier";
}

function normalizeDeviceFamily(deviceFamily?: DeviceFamily): DeviceFamily {
  if (deviceFamily && DEVICE_FAMILIES.has(deviceFamily)) return deviceFamily;
  return "unknown";
}

const SUBJECTS: Record<SecurityEventType, string> = {
  new_sign_in: "New sign-in to your account",
  mfa_change: "Multi-factor authentication changed",
  data_export: "Your data was exported",
  card_rotation: "Your card link was rotated",
};

const BODIES: Record<SecurityEventType, string> = {
  new_sign_in:
    "A new sign-in to your account was detected. Time: {time}. Device: {device}. If this was not you, secure your account immediately.",
  mfa_change:
    "Multi-factor authentication settings on your account were changed. Time: {time}. Device: {device}. If this was not you, secure your account immediately.",
  data_export:
    "Your account data was exported. Time: {time}. Device: {device}. If this was not you, secure your account immediately.",
  card_rotation:
    "Your card link was rotated. Time: {time}. Device: {device}. If this was not you, secure your account immediately.",
};

const COARSE_TIME_LABELS: Record<CoarseTime, string> = {
  today: "today",
  yesterday: "yesterday",
  this_week: "earlier this week",
  earlier: "earlier",
};

const DEVICE_LABELS: Record<DeviceFamily, string> = {
  desktop: "a desktop computer",
  mobile: "a mobile device",
  tablet: "a tablet",
  unknown: "an unrecognized device",
};

/**
 * Render a notification from the event catalogue. The output contains only the
 * event type, a coarse time, and a device family — never PHI.
 */
export function renderNotification(event: SecurityEvent): RenderedNotification {
  const coarseTime = toCoarseTime(event.occurredAt);
  const deviceFamily = normalizeDeviceFamily(event.deviceFamily);
  const body = BODIES[event.type]
    .replace("{time}", COARSE_TIME_LABELS[coarseTime])
    .replace("{device}", DEVICE_LABELS[deviceFamily]);
  return {
    eventType: event.type,
    coarseTime,
    deviceFamily,
    subject: SUBJECTS[event.type],
    body,
  };
}

/**
 * Stable idempotency key so each catalogued event triggers exactly one
 * notification, even if the triggering action is retried.
 */
export function idempotencyKey(event: SecurityEvent): string {
  return createHash("sha256")
    .update(`${event.type}:${event.userId}:${event.eventId}`)
    .digest("hex");
}

/**
 * Whether a notification should be sent given the user's preferences.
 * Critical security events are always sent.
 */
export function shouldNotify(
  eventType: SecurityEventType,
  preferences: NotificationPreferences = {},
): boolean {
  if (CRITICAL_EVENTS.has(eventType)) return true;
  return !preferences.disabled?.[eventType];
}

/**
 * Dispatch a security event through the outbox. Fast and idempotent: the
 * triggering action only enqueues; delivery happens asynchronously.
 */
export async function dispatchSecurityEvent(
  event: SecurityEvent,
  outbox: NotificationOutbox,
  preferences: NotificationPreferences = {},
): Promise<{ enqueued: boolean }> {
  if (!shouldNotify(event.type, preferences)) {
    return { enqueued: false };
  }
  const rendered = renderNotification(event);
  await outbox.enqueue({
    idempotencyKey: idempotencyKey(event),
    userId: event.userId,
    eventType: rendered.eventType,
    coarseTime: rendered.coarseTime,
    deviceFamily: rendered.deviceFamily,
  });
  return { enqueued: true };
}
