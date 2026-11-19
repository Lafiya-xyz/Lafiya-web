/**
 * Core types for the notification service abstraction (issue #625).
 *
 * Privacy rules (strictly enforced):
 *   • PHI (names, dates, clinical fields) must NEVER appear in notification
 *     payloads sent to third-party providers.
 *   • Template variables are validated by the PHI lint in templateRegistry.ts
 *     before any provider call.
 *   • Recipient addresses (phone numbers, email addresses) are passed directly
 *     to the provider SDK and must not be logged.
 */

/** Supported delivery channels. */
export type NotificationChannel = "email" | "sms" | "push";

/** BCP-47 locale codes supported by the template registry. */
export type SupportedLocale = "en" | "ha" | "ig" | "yo";

/** A resolved, provider-ready message. */
export interface RenderedMessage {
  subject?: string; // email only
  body: string;
}

/** The canonical send-request interface. */
export interface SendRequest {
  channel: NotificationChannel;
  template: string;
  locale: SupportedLocale;
  /** Recipient address — phone (E.164) for SMS, email for email, device token for push. */
  to: string;
  /** Template variable substitutions.  PHI variables are rejected at render time. */
  vars: Record<string, string>;
  /**
   * Caller-generated UUID.  Providers that support idempotency keys (Termii,
   * SendGrid) receive it directly; others use it for de-dup in the delivery
   * tracking table.
   */
  idempotencyKey: string;
  /** Recipient account; when present, notification preferences apply (#804). */
  userId?: string;
}

/** What `sendNotification` did with a request. */
export type SendOutcome =
  | "sent"
  | "failed"
  | "duplicate"
  | "suppressed"
  | "skipped"
  | "deferred"
  | "batched";

/** Unified result returned by every provider adapter. */
export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; retryable: boolean };

/** Delivery status recorded in `notification_deliveries`. */
export type DeliveryStatus = "sent" | "failed" | "duplicate";

/**
 * Data classification for a single payload field, consumed by the AsyncAPI
 * generator (issue #971) to annotate notification payload schemas.
 *
 *   • "public"       — safe to expose anywhere.
 *   • "internal"     — operational metadata, not for third parties.
 *   • "confidential" — recipient identifiers (phone, email, device token).
 *   • "phi"          — clinical or personally identifying health data; must
 *                      never leave the platform in a provider payload.
 */
export type DataClassification = "public" | "internal" | "confidential" | "phi";

/** A documented field within a notification payload schema. */
export interface NotificationPayloadField {
  /** Field name as it appears in the payload. */
  name: string;
  /** JSON-schema-ish type descriptor, e.g. "string", "string (uuid)". */
  type: string;
  /** Whether the field must be present. */
  required: boolean;
  /** PHI / sensitivity classification for the field. */
  classification: DataClassification;
  /** Human-readable description for the generated docs. */
  description?: string;
}

/**
 * Catalog entry describing a notification payload schema for one channel.
 * Mirrors the outbox event catalog so both are rendered from the same
 * AsyncAPI document.
 */
export interface NotificationPayloadSchema {
  /** Stable schema identifier, e.g. "notification.email.v1". */
  schemaId: string;
  channel: NotificationChannel;
  /** Fields carried by the payload, each with its classification. */
  fields: NotificationPayloadField[];
  /**
   * True when the schema is guaranteed to contain no PHI fields.  The
   * generator asserts this for every outbound provider payload.
   */
  phiFree: boolean;
}
