/**
 * Issue #937: partner webhook delivery console.
 *
 * Every delivery attempt is stored with a REDACTED snapshot (headers with
 * secrets stripped, body replaced by a SHA-256 + byte length) so partners can
 * inspect failures without PHI or capability tokens ever being persisted.
 *
 * Replay re-sends the stored request with the ORIGINAL idempotency key so a
 * receiver can deduplicate, and is rate limited per endpoint. Secret rotation
 * keeps the previous signing secret valid until the grace period ends, so
 * in-flight deliveries signed with the old secret still verify.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { MS_PER_SECOND } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const DEFAULT_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;
export const REPLAY_RATE_LIMIT = { limit: 10, windowMs: 60 * 1000 } as const;
export const RESPONSE_EXCERPT_BYTES = 2048;
export const DELIVERY_TIMEOUT_MS = 10_000;

/** Headers that must never be persisted or echoed back to a partner. */
const REDACTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-lafiya-signature",
  "x-lafiya-secret",
  "proxy-authorization",
]);

export interface WebhookEndpoint {
  id: string;
  partnerId: string;
  url: string;
  secretPrefix: string;
  previousSecretExpiresAt: string | null;
  disabledAt: string | null;
}

export interface DeliveryRecord {
  id: string;
  endpointId: string;
  partnerId: string;
  eventType: string;
  idempotencyKey: string;
  requestHeaders: Record<string, string>;
  requestBodySha256: string;
  requestBodyBytes: number;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBodyExcerpt: string | null;
  durationMs: number | null;
  error: string | null;
  attempt: number;
  replayedFrom: string | null;
  createdAt: string;
}

function db(): SupabaseClient {
  // partner_webhook_* tables are not in the generated types yet.
  return createAdminClient({ purpose: "partner-webhooks" }) as unknown as SupabaseClient;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateWebhookSecret(): { secret: string; prefix: string; hash: string } {
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 14), hash: hashSecret(secret) };
}

/** `sha256=<hex>` HMAC over the raw body, as sent in `X-Lafiya-Signature`. */
export function signWebhookBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** Constant-time check of a signature against the active and previous secrets. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secrets: string[],
): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(signWebhookBody(secret, rawBody).slice("sha256=".length), "hex");
    valid = (expected.length === given.length && timingSafeEqual(expected, given)) || valid;
  }
  return valid;
}

/** Strips secret-bearing headers and truncates values before persistence. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    out[key] = REDACTED_HEADERS.has(key) ? "[redacted]" : value.slice(0, 512);
  }
  return out;
}

export function bodyDigest(rawBody: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash("sha256").update(rawBody, "utf8").digest("hex"),
    bytes: Buffer.byteLength(rawBody, "utf8"),
  };
}

export async function listEndpoints(partnerId: string): Promise<WebhookEndpoint[]> {
  const { data, error } = await db()
    .from("partner_webhook_endpoints")
    .select("id, partner_id, url, secret_prefix, previous_secret_expires_at, disabled_at")
    .eq("partner_id", partnerId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id as string,
    partnerId: row.partner_id as string,
    url: row.url as string,
    secretPrefix: row.secret_prefix as string,
    previousSecretExpiresAt: (row.previous_secret_expires_at as string | null) ?? null,
    disabledAt: (row.disabled_at as string | null) ?? null,
  }));
}

/** Creates an endpoint; the returned `secret` is the only time it is visible. */
export async function createEndpoint(input: {
  partnerId: string;
  url: string;
}): Promise<{ id: string; secret: string }> {
  const { secret, prefix, hash } = generateWebhookSecret();
  const { data, error } = await db()
    .from("partner_webhook_endpoints")
    .insert({ partner_id: input.partnerId, url: input.url, secret_hash: hash, secret_prefix: prefix })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id as string, secret };
}

/**
 * Rotates the signing secret. The previous secret keeps verifying until
 * `graceMs` elapses, so no event is dropped mid-rotation.
 */
export async function rotateEndpointSecret(
  endpointId: string,
  graceMs = DEFAULT_SECRET_GRACE_MS,
): Promise<{ secret: string; previousValidUntil: string }> {
  const { secret, prefix, hash } = generateWebhookSecret();
  const previousValidUntil = new Date(Date.now() + graceMs).toISOString();
  const { error } = await db().rpc("partner_webhook_rotate_secret", {
    p_endpoint_id: endpointId,
    p_new_hash: hash,
    p_new_prefix: prefix,
    p_grace_until: previousValidUntil,
  });
  if (error) throw error;
  return { secret, previousValidUntil };
}

/** Secrets that currently verify for an endpoint (active + unexpired previous). */
export async function activeSecretHashes(endpointId: string): Promise<string[]> {
  const { data, error } = await db()
    .from("partner_webhook_endpoints")
    .select("secret_hash, previous_secret_hash, previous_secret_expires_at")
    .eq("id", endpointId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return [];
  const hashes = [data.secret_hash as string];
  const previousExpiry = data.previous_secret_expires_at as string | null;
  if (data.previous_secret_hash && previousExpiry && new Date(previousExpiry).getTime() > Date.now()) {
    hashes.push(data.previous_secret_hash as string);
  }
  return hashes;
}

function toDelivery(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: row.id as string,
    endpointId: row.endpoint_id as string,
    partnerId: row.partner_id as string,
    eventType: row.event_type as string,
    idempotencyKey: row.idempotency_key as string,
    requestHeaders: (row.request_headers as Record<string, string>) ?? {},
    requestBodySha256: row.request_body_sha256 as string,
    requestBodyBytes: (row.request_body_bytes as number) ?? 0,
    responseStatus: (row.response_status as number | null) ?? null,
    responseHeaders: (row.response_headers as Record<string, string>) ?? {},
    responseBodyExcerpt: (row.response_body_excerpt as string | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    attempt: (row.attempt as number) ?? 1,
    replayedFrom: (row.replayed_from as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export async function listDeliveries(filter: {
  partnerId: string;
  endpointId?: string;
  limit?: number;
}): Promise<DeliveryRecord[]> {
  let query = db()
    .from("partner_webhook_deliveries")
    .select("*")
    .eq("partner_id", filter.partnerId)
    .order("created_at", { ascending: false })
    .limit(Math.min(filter.limit ?? 50, 200));
  if (filter.endpointId) query = query.eq("endpoint_id", filter.endpointId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((row) => toDelivery(row as Record<string, unknown>));
}

export async function getDelivery(partnerId: string, deliveryId: string): Promise<DeliveryRecord | null> {
  const { data, error } = await db()
    .from("partner_webhook_deliveries")
    .select("*")
    .eq("id", deliveryId)
    .eq("partner_id", partnerId)
    .maybeSingle();
  if (error) throw error;
  return data ? toDelivery(data as Record<string, unknown>) : null;
}

export interface ReplayDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window replay limiter per endpoint, backed by the delivery table so
 * it is shared across instances: a replay is counted by inserting its row.
 */
export async function checkReplayRateLimit(
  endpointId: string,
  now: number = Date.now(),
): Promise<ReplayDecision> {
  const since = new Date(now - REPLAY_RATE_LIMIT.windowMs).toISOString();
  const { count, error } = await db()
    .from("partner_webhook_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("endpoint_id", endpointId)
    .not("replayed_from", "is", null)
    .gte("created_at", since);
  if (error) throw error;
  const used = count ?? 0;
  return {
    allowed: used < REPLAY_RATE_LIMIT.limit,
    retryAfterSeconds: Math.max(1, Math.ceil(REPLAY_RATE_LIMIT.windowMs / MS_PER_SECOND)),
  };
}

/**
 * Re-sends a stored delivery. The original idempotency key and redacted
 * request headers are preserved; the body is re-sent from `rawBody` supplied
 * by the caller (bodies are never persisted). The attempt is recorded as a
 * new row linked to the original via `replayed_from`.
 */
export async function replayDelivery(input: {
  delivery: DeliveryRecord;
  rawBody: string;
  secret: string;
  fetchImpl?: typeof fetch;
}): Promise<DeliveryRecord> {
  const { delivery, rawBody, secret } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const endpoint = await db()
    .from("partner_webhook_endpoints")
    .select("url")
    .eq("id", delivery.endpointId)
    .maybeSingle();
  if (endpoint.error) throw endpoint.error;
  if (!endpoint.data) throw new Error("unknown webhook endpoint");

  const headers: Record<string, string> = {
    ...delivery.requestHeaders,
    "content-type": "application/json",
    "idempotency-key": delivery.idempotencyKey,
    "x-lafiya-signature": signWebhookBody(secret, rawBody),
    "x-lafiya-replay": "true",
  };

  const startedAt = Date.now();
  let status: number | null = null;
  let responseHeaders: Record<string, string> = {};
  let excerpt: string | null = null;
  let error: string | null = null;
  try {
    const response = await doFetch(endpoint.data.url as string, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    status = response.status;
    responseHeaders = redactHeaders(Object.fromEntries(response.headers.entries()));
    excerpt = (await response.text()).slice(0, RESPONSE_EXCERPT_BYTES);
  } catch (cause) {
    error = cause instanceof Error ? cause.message.slice(0, 512) : "delivery failed";
  }

  const digest = bodyDigest(rawBody);
  const { data, error: insertError } = await db()
    .from("partner_webhook_deliveries")
    .insert({
      endpoint_id: delivery.endpointId,
      partner_id: delivery.partnerId,
      event_type: delivery.eventType,
      idempotency_key: delivery.idempotencyKey,
      request_headers: redactHeaders(headers),
      request_body_sha256: digest.sha256,
      request_body_bytes: digest.bytes,
      response_status: status,
      response_headers: responseHeaders,
      response_body_excerpt: excerpt,
      duration_ms: Date.now() - startedAt,
      error,
      attempt: delivery.attempt + 1,
      replayed_from: delivery.id,
    })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return toDelivery(data as Record<string, unknown>);
}
