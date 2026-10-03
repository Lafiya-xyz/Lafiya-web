/**
 * Notification service abstraction (issue #625).
 *
 * Public API:
 *   sendNotification(request: SendRequest): Promise<void>
 *
 * Internally:
 *   1. Renders the template (PHI lint applied).
 *   2. Checks the `notification_deliveries` table for a prior send with the
 *      same idempotencyKey — returns early on duplicate.
 *   3. Tries providers in priority order, respecting per-provider circuit
 *      breakers (Termii → Twilio for SMS).
 *   4. Records the delivery result (sent / failed / duplicate).
 *
 * Only SMS is wired to live providers today.  Email and push stubs are in
 * place for future implementation.
 *
 * Privacy: no PHI or recipient addresses are logged.  Provider errors are
 * logged at warn/error level without the `to` field.
 */

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { logError, logInfo, logWarn } from "@/lib/logging/logger";
import { renderTemplate } from "./templates";
import { CircuitBreaker } from "./circuit-breaker";
import { sendViaTerm } from "./providers/termii";
import { sendViaTwilio } from "./providers/twilio";
import type { SendRequest, SendResult, DeliveryStatus } from "./types";

// ─── Provider circuit breakers (module-level singletons) ────────────────────
const termiiBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 });
const twilioBreaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 30_000 });

// ─── Delivery tracking ───────────────────────────────────────────────────────

async function recordDelivery(
  idempotencyKey: string,
  channel: string,
  template: string,
  status: DeliveryStatus,
  providerId?: string,
  errorMessage?: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "notification_deliveries" as any,
  ).upsert(
    {
      idempotency_key: idempotencyKey,
      channel,
      template,
      status,
      provider_id: providerId ?? null,
      error_message: errorMessage ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "idempotency_key" },
  );
  if (error) {
    logWarn("notifications: failed to record delivery status", {
      template,
      status,
    });
  }
}

async function isDuplicate(idempotencyKey: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_deliveries" as any)
    .select("status")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === "sent";
}

// ─── Failover send ───────────────────────────────────────────────────────────

async function sendSms(
  to: string,
  body: string,
  idempotencyKey: string,
): Promise<SendResult> {
  // Primary: Termii
  if (termiiBreaker.isAvailable()) {
    const apiKey = process.env.TERMII_API_KEY;
    const senderId = process.env.TERMII_SENDER_ID;
    if (apiKey && senderId) {
      const result = await sendViaTerm(to, body, idempotencyKey, { apiKey, senderId });
      if (result.ok) {
        termiiBreaker.recordSuccess();
        return result;
      }
      if (result.retryable) {
        termiiBreaker.recordFailure();
      }
      logWarn("notifications: Termii send failed, trying Twilio", {
        retryable: result.retryable,
      });
    }
  } else {
    logWarn("notifications: Termii circuit open, skipping to Twilio", {
      state: termiiBreaker.getState(),
    });
  }

  // Fallback: Twilio
  if (twilioBreaker.isAvailable()) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_FROM_NUMBER;
    if (accountSid && authToken && fromNumber) {
      const result = await sendViaTwilio(to, body, idempotencyKey, {
        accountSid,
        authToken,
        fromNumber,
      });
      if (result.ok) {
        twilioBreaker.recordSuccess();
      } else if (result.retryable) {
        twilioBreaker.recordFailure();
      }
      return result;
    }
  } else {
    logWarn("notifications: Twilio circuit open — both SMS providers unavailable", {
      state: twilioBreaker.getState(),
    });
  }

  return {
    ok: false,
    error: "No SMS provider available (check circuit breaker state and env vars).",
    retryable: true,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a notification.
 *
 * Idempotent: a second call with the same `idempotencyKey` is a no-op when
 * the first was delivered successfully.
 *
 * @throws if the template is unknown or contains PHI variable keys.
 */
export async function sendNotification(request: SendRequest): Promise<void> {
  const { channel, template, locale, to, vars, idempotencyKey } = request;

  // 1. Render (applies PHI lint).
  const rendered = renderTemplate(template, locale, vars);

  // 2. Idempotency guard.
  if (await isDuplicate(idempotencyKey)) {
    logInfo("notifications: duplicate suppressed", { template, channel });
    return;
  }

  // 3. Send.
  let result: SendResult;

  switch (channel) {
    case "sms": {
      result = await sendSms(to, rendered.body, idempotencyKey);
      break;
    }
    case "email":
    case "push": {
      // Stubs — wire to providers when implemented.
      logWarn(`notifications: channel "${channel}" not yet implemented`, { template });
      result = { ok: false, error: `Channel ${channel} not implemented`, retryable: false };
      break;
    }
    default: {
      const exhaustive: never = channel;
      logError(`notifications: unknown channel`, new Error(`Unknown channel: ${exhaustive as string}`));
      result = { ok: false, error: "Unknown channel", retryable: false };
    }
  }

  // 4. Record delivery.
  const status: DeliveryStatus = result.ok ? "sent" : "failed";
  await recordDelivery(
    idempotencyKey,
    channel,
    template,
    status,
    result.ok ? result.providerId : undefined,
    result.ok ? undefined : result.error,
  );

  if (!result.ok) {
    logError("notifications: send failed", new Error(result.error), {
      template,
      channel,
      retryable: result.retryable,
    });
  }
}
