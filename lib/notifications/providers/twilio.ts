/**
 * Twilio SMS provider adapter (issue #625).
 *
 * Twilio is the secondary (failover) SMS provider.  Used when Termii is
 * unavailable or returns a retryable error.
 *
 * Privacy: the `to` phone number is passed directly to Twilio and must never
 * be logged.  The message body must already be PHI-free.
 */

import type { SendResult } from "../types";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  baseUrl?: string;
}

/**
 * Send an SMS via Twilio Programmable Messaging.
 * https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
 */
export async function sendViaTwilio(
  to: string,
  body: string,
  idempotencyKey: string,
  config: TwilioConfig,
): Promise<SendResult> {
  const base = config.baseUrl ?? "https://api.twilio.com";
  const url = `${base}/2010-04-01/Accounts/${config.accountSid}/Messages.json`;

  const params = new URLSearchParams({
    To: to,
    From: config.fromNumber,
    Body: body,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Twilio supports an idempotency key via the X-Twilio-Idempotency-Token header.
        "X-Twilio-Idempotency-Token": idempotencyKey,
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
      },
      body: params.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
      retryable: true,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Twilio responded with HTTP ${response.status}`,
      retryable: response.status >= 500,
    };
  }

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Twilio returned non-JSON body", retryable: false };
  }

  return { ok: true, providerId: `twilio:${String(json["sid"] ?? idempotencyKey)}` };
}
