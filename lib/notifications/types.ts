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
}

/** Unified result returned by every provider adapter. */
export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string; retryable: boolean };

/** Delivery status recorded in `notification_deliveries`. */
export type DeliveryStatus = "sent" | "failed" | "duplicate";
