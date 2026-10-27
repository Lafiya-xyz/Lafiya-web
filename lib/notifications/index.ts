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
 * Also enforced here (never at call sites):
 *   • notification preferences / quiet hours / mandatory classes (#804)
 *   • the email suppression list (#802)
 *   • regulator-aware SMS route class per template (#805)
 * and delivery receipts are reconciled into `notification_deliveries` (#803).
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
import { decide, fromRow as prefsFromRow } from "./preferences";
import {
  DELIVERY_DEADLINE_MS,
  countryPrefix,
  nextState,
  nigerianNetwork,
  successRates,
  type DeliveryMetricRow,
  type DeliveryState,
  type SmsProvider,
} from "./receipts";
import { TERMII_CHANNEL, routeFor } from "./routing";
import {
  applyEmailEvent,
  canSendEmail,
  fromRow as suppressionFromRow,
  hashAddress,
  isActiveSuppression,
  releaseSuppression,
  toRow as suppressionToRow,
  type EmailEvent,
} from "./suppression";
import type { SendRequest, SendResult, DeliveryStatus, SendOutcome } from "./types";

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
  extra: Record<string, unknown> = {},
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
      ...extra,
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
  termiiChannel: string,
): Promise<SendResult> {
  // Primary: Termii
  if (termiiBreaker.isAvailable()) {
    const apiKey = process.env.TERMII_API_KEY;
    const senderId = process.env.TERMII_SENDER_ID;
    if (apiKey && senderId) {
      const result = await sendViaTerm(to, body, idempotencyKey, {
        apiKey,
        senderId,
        channel: termiiChannel,
      });
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

// ─── Preferences & suppression ───────────────────────────────────────────────

async function loadPreferences(userId: string) {
  const { data } = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_preferences" as any)
    .select("timezone, quiet_start, quiet_end, channels, batch_low_priority")
    .eq("user_id", userId)
    .maybeSingle();
  return prefsFromRow(data as Parameters<typeof prefsFromRow>[0]);
}

async function loadSuppression(hash: string) {
  const { data } = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("email_suppressions" as any)
    .select("reason, soft_count, expires_at, released_at")
    .eq("address_hash", hash)
    .maybeSingle();
  return suppressionFromRow(data as Parameters<typeof suppressionFromRow>[0]);
}

/** Record a bounce/complaint from the email provider webhook (#802). */
export async function recordEmailEvent(event: EmailEvent): Promise<void> {
  const hash = hashAddress(event.email);
  const next = applyEmailEvent(await loadSuppression(hash), event);
  const { error } = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("email_suppressions" as any)
    .upsert(suppressionToRow(hash, next), { onConflict: "address_hash" });
  if (error) logWarn("notifications: failed to record email suppression", { reason: next.reason });
}

/** Manually release a suppressed address (support tooling, #802). */
export async function releaseEmailSuppression(email: string, releasedBy: string): Promise<boolean> {
  const hash = hashAddress(email);
  const current = await loadSuppression(hash);
  if (!current) return false;
  const { error } = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("email_suppressions" as any)
    .update({ ...suppressionToRow(hash, releaseSuppression(current)), released_by: releasedBy })
    .eq("address_hash", hash);
  return !error;
}

/** Whether mail to this address is currently suppressed — drives the "may be unreachable" notice. */
export async function isEmailUnreachable(email: string): Promise<boolean> {
  return isActiveSuppression(await loadSuppression(hashAddress(email)));
}

// ─── Delivery receipts (#803) ────────────────────────────────────────────────

/**
 * Apply a normalized delivery receipt. Idempotent and monotonic: replayed or
 * out-of-order receipts never move a delivery backwards, and the update is
 * conditioned on the state we read so concurrent receipts cannot regress it.
 * Returns the state now stored, or null if the message is unknown.
 */
export async function applyDeliveryReceipt(
  provider: SmsProvider,
  providerMessageId: string,
  incoming: DeliveryState,
  onUndelivered?: (idempotencyKey: string) => Promise<void>,
): Promise<DeliveryState | null> {
  const admin = createAdminClient();
  const providerId = `${provider}:${providerMessageId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data } = await admin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("notification_deliveries" as any)
      .select("idempotency_key, delivery_state")
      .eq("provider_id", providerId)
      .maybeSingle();
    const row = data as { idempotency_key: string; delivery_state: DeliveryState } | null;
    if (!row) return null;
    const target = nextState(row.delivery_state, incoming);
    if (target === row.delivery_state) return target;
    const { data: updated } = await admin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("notification_deliveries" as any)
      .update({ delivery_state: target, receipt_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("provider_id", providerId)
      .eq("delivery_state", row.delivery_state)
      .select("idempotency_key");
    if (updated && (updated as unknown[]).length > 0) {
      if ((target === "undelivered" || target === "failed") && onUndelivered) {
        await onUndelivered(row.idempotency_key);
      }
      return target;
    }
  }
  return null;
}

/**
 * Find SMS still unconfirmed past their delivery deadline, mark them
 * escalated (once) and hand each idempotency key to `escalate`, which sends
 * via the alternate channel. Intended for a cron route.
 */
export async function escalateOverdueDeliveries(
  escalate: (idempotencyKey: string) => Promise<void>,
  now: Date = new Date(),
): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_deliveries" as any)
    .select("idempotency_key")
    .in("delivery_state", ["pending", "accepted", "sent"])
    .is("escalated_at", null)
    .lt("deliver_by", now.toISOString())
    .limit(100);
  let count = 0;
  for (const { idempotency_key } of (data ?? []) as { idempotency_key: string }[]) {
    const { data: claimed } = await admin
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("notification_deliveries" as any)
      .update({ escalated_at: now.toISOString() })
      .eq("idempotency_key", idempotency_key)
      .is("escalated_at", null)
      .select("idempotency_key");
    if (claimed && (claimed as unknown[]).length > 0) {
      await escalate(idempotency_key);
      count++;
    }
  }
  return count;
}

/**
 * Delivery success rates over the last `windowHours`, by provider + country
 * prefix and by Nigerian network (#803, #805). No phone numbers involved.
 */
export async function smsDeliveryMetrics(windowHours = 24) {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const { data, error } = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("notification_deliveries" as any)
    .select("provider, country_prefix, network, delivery_state")
    .eq("channel", "sms")
    .gte("created_at", since)
    .limit(10_000);
  if (error) return null;
  const rows = (data ?? []) as unknown as DeliveryMetricRow[];
  return {
    byProviderCountry: successRates(rows, (r) => `${r.provider ?? "unknown"}:+${r.country_prefix ?? "?"}`),
    byNetwork: successRates(
      rows.filter((r) => r.country_prefix === "234"),
      (r) => r.network ?? "unknown",
    ),
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
export async function sendNotification(request: SendRequest): Promise<SendOutcome> {
  const { channel, template, locale, to, vars, idempotencyKey, userId } = request;

  // 1. Render (applies PHI lint).
  const rendered = renderTemplate(template, locale, vars);

  // 2. Preferences (#804). Mandatory classes always return "send". "defer"
  //    and "batch" are returned to the caller (the outbox) to reschedule.
  if (userId) {
    const decision = decide(template, channel, await loadPreferences(userId));
    if (decision !== "send") {
      logInfo("notifications: held by preferences", { template, channel, decision });
      return decision === "skip" ? "skipped" : decision === "defer" ? "deferred" : "batched";
    }
  }

  // 3. Idempotency guard.
  if (await isDuplicate(idempotencyKey)) {
    logInfo("notifications: duplicate suppressed", { template, channel });
    return "duplicate";
  }

  // 4. Email suppression list (#802).
  if (channel === "email" && !canSendEmail(await loadSuppression(hashAddress(to)), template)) {
    logInfo("notifications: suppressed address", { template, channel });
    await recordDelivery(idempotencyKey, channel, template, "failed", undefined, "suppressed");
    return "suppressed";
  }

  // 3. Send.
  let result: SendResult;

  switch (channel) {
    case "sms": {
      // Route class per template (#805): throws for an unmapped template.
      const route = routeFor(template);
      result = await sendSms(to, rendered.body, idempotencyKey, TERMII_CHANNEL[route.routeClass]);
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

  // 5. Record delivery.
  const status: DeliveryStatus = result.ok ? "sent" : "failed";
  const extra: Record<string, unknown> = {};
  if (channel === "sms") {
    extra.country_prefix = countryPrefix(to);
    extra.network = extra.country_prefix === "234" ? nigerianNetwork(to) : null;
    if (result.ok) {
      extra.provider = result.providerId.split(":")[0];
      extra.delivery_state = "accepted";
      extra.deliver_by = new Date(Date.now() + DELIVERY_DEADLINE_MS).toISOString();
    } else {
      extra.delivery_state = "failed";
    }
  }
  await recordDelivery(
    idempotencyKey,
    channel,
    template,
    status,
    result.ok ? result.providerId : undefined,
    result.ok ? undefined : result.error,
    extra,
  );

  if (!result.ok) {
    logError("notifications: send failed", new Error(result.error), {
      template,
      channel,
      retryable: result.retryable,
    });
  }

  return status;
}
