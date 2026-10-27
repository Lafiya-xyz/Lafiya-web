/**
 * SMS delivery-receipt reconciliation (issues #803, #805).
 *
 * Provider statuses are mapped onto a normalized, monotonic state machine:
 *
 *   pending → accepted → sent → delivered | undelivered | failed
 *
 * A receipt can only move a delivery forward (by rank); terminal states never
 * change. That makes replayed and out-of-order receipts harmless.
 *
 * Privacy: phone numbers are reduced to a country calling-code prefix and a
 * mobile network name before anything is stored or counted.
 */

import { createHmac, timingSafeEqual } from "crypto";

export type DeliveryState = "pending" | "accepted" | "sent" | "delivered" | "undelivered" | "failed";
export type SmsProvider = "termii" | "twilio";
export type NigerianNetwork = "mtn" | "airtel" | "glo" | "9mobile" | "unknown";

const RANK: Record<DeliveryState, number> = {
  pending: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
};

export function isTerminal(state: DeliveryState): boolean {
  return RANK[state] === 3;
}

/** Monotonic merge: returns the state to persist given current and incoming. */
export function nextState(current: DeliveryState, incoming: DeliveryState): DeliveryState {
  if (isTerminal(current)) return current;
  return RANK[incoming] > RANK[current] ? incoming : current;
}

const TWILIO_MAP: Record<string, DeliveryState> = {
  accepted: "accepted",
  queued: "accepted",
  scheduled: "accepted",
  sending: "sent",
  sent: "sent",
  delivered: "delivered",
  read: "delivered",
  undelivered: "undelivered",
  failed: "failed",
  canceled: "failed",
};

const TERMII_MAP: Record<string, DeliveryState> = {
  "message sent": "sent",
  sent: "sent",
  "delivered": "delivered",
  "dnd active on phone number": "undelivered",
  "message failed": "failed",
  failed: "failed",
  rejected: "failed",
  expired: "undelivered",
  undelivered: "undelivered",
  pending: "accepted",
  received: "accepted",
};

export function normalizeStatus(provider: SmsProvider, status: string): DeliveryState | null {
  const key = status.trim().toLowerCase();
  return (provider === "twilio" ? TWILIO_MAP : TERMII_MAP)[key] ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Twilio: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)).
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
  authToken: string | undefined,
): boolean {
  if (!signature || !authToken) return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  return safeEqual(expected, signature);
}

/** Termii: hex(HMAC-SHA512(secret, rawBody)) in `X-Termii-Signature`. */
export function verifyTermiiSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha512", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature.toLowerCase());
}

/** Calling-code prefix only (1–3 digits). Never returns the subscriber number. */
export function countryPrefix(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  for (const p of ["234", "233", "254", "27", "44", "1"]) {
    if (digits.startsWith(p)) return p;
  }
  return digits.slice(0, 3);
}

const NG_NETWORK_PREFIXES: Record<Exclude<NigerianNetwork, "unknown">, string[]> = {
  mtn: ["0703", "0706", "0803", "0806", "0810", "0813", "0814", "0816", "0903", "0906", "0913", "0916", "07025", "07026", "0704"],
  airtel: ["0701", "0708", "0802", "0808", "0812", "0901", "0902", "0904", "0907", "0912"],
  glo: ["0705", "0805", "0807", "0811", "0815", "0905", "0915"],
  "9mobile": ["0809", "0817", "0818", "0908", "0909"],
};

/** Map a Nigerian number to its originating network by NDC prefix. */
export function nigerianNetwork(e164: string): NigerianNetwork {
  const digits = e164.replace(/\D/g, "");
  if (!digits.startsWith("234")) return "unknown";
  const local = "0" + digits.slice(3);
  let best: NigerianNetwork = "unknown";
  let bestLen = 0;
  for (const [net, prefixes] of Object.entries(NG_NETWORK_PREFIXES)) {
    for (const p of prefixes) {
      if (local.startsWith(p) && p.length > bestLen) {
        best = net as NigerianNetwork;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Deadline after which an unconfirmed SMS triggers failover/escalation. */
export const DELIVERY_DEADLINE_MS = 10 * 60 * 1000;

export interface DeliveryMetricRow {
  provider: string | null;
  country_prefix: string | null;
  network: string | null;
  delivery_state: DeliveryState;
}

export interface SuccessRate {
  key: string;
  delivered: number;
  total: number;
  rate: number | null;
}

/** Delivery success rate over terminal deliveries, grouped by a key function. */
export function successRates(
  rows: DeliveryMetricRow[],
  keyOf: (r: DeliveryMetricRow) => string,
): SuccessRate[] {
  const groups = new Map<string, { delivered: number; total: number }>();
  for (const r of rows) {
    if (!isTerminal(r.delivery_state)) continue;
    const k = keyOf(r);
    const g = groups.get(k) ?? { delivered: 0, total: 0 };
    g.total += 1;
    if (r.delivery_state === "delivered") g.delivered += 1;
    groups.set(k, g);
  }
  return [...groups].map(([key, g]) => ({
    key,
    ...g,
    rate: g.total ? Math.round((g.delivered / g.total) * 1000) / 1000 : null,
  }));
}
