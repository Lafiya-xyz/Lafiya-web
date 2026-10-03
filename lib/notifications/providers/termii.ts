/**
 * Termii SMS provider adapter (issue #625).
 *
 * Termii is the primary Nigerian SMS provider.  This adapter implements the
 * `ProviderAdapter` interface so it can be used in the failover chain.
 *
 * Privacy: the `to` (phone number) is passed directly to the Termii API and
 * must never be logged.  The message body must already be PHI-free (enforced
 * by the template PHI lint before this adapter is called).
 */

import type { SendResult } from "../types";

export interface TermiiConfig {
  apiKey: string;
  senderId: string;
  baseUrl?: string;
}

/**
 * Send an SMS via Termii.
 * https://developers.termii.com/messaging
 */
export async function sendViaTerm(
  to: string,
  body: string,
  idempotencyKey: string,
  config: TermiiConfig,
): Promise<SendResult> {
  const url = `${config.baseUrl ?? "https://v3.api.termii.com"}/api/sms/send`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        from: config.senderId,
        sms: body,
        type: "plain",
        channel: "generic",
        api_key: config.apiKey,
        // Termii supports message_id for idempotency on retries.
        message_id: idempotencyKey,
      }),
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
      error: `Termii responded with HTTP ${response.status}`,
      retryable: response.status >= 500,
    };
  }

  let json: Record<string, unknown>;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Termii returned non-JSON body", retryable: false };
  }

  const msgId = String(json["message_id"] ?? json["messageId"] ?? idempotencyKey);
  return { ok: true, providerId: `termii:${msgId}` };
}
