/**
 * Issue #809: partner API keys, quotas and usage metering.
 *
 * Keys look like `lfy_<prefix>_<secret>`. The full key is returned exactly
 * once at issue time; only its SHA-256 is stored. Rotation issues a new key
 * and sets `expires_at` on the old one so both work during the overlap.
 *
 * Quota enforcement is a single atomic Postgres call
 * (`partner_api_consume`), safe under concurrency across instances. Error
 * semantics: over quota → 429 with `Retry-After` (seconds) and
 * `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers;
 * rejected requests are not charged. Missing/invalid/expired keys → 401;
 * key lacking the endpoint's scope → 403.
 */

import { createHash, randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { MS_PER_SECOND } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export const PARTNER_KEY_PATTERN = /^lfy_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
export const DEFAULT_ROTATION_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

export interface PartnerKey {
  id: string;
  partnerId: string;
  scopes: string[];
  ratePerMinute: number;
  monthlyQuota: number;
}

export interface QuotaDecision {
  allowed: boolean;
  headers: Record<string, string>;
}

function db(): SupabaseClient {
  // partner_api_* tables are not in the generated types yet.
  return createAdminClient({ purpose: "partner-api" }) as unknown as SupabaseClient;
}

export function hashPartnerKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generatePartnerKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const key = `lfy_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, hash: hashPartnerKey(key) };
}

/** Issues a key; the returned `key` is the only time the secret is visible. */
export async function issuePartnerKey(input: {
  partnerId: string;
  scopes: string[];
  ratePerMinute?: number;
  monthlyQuota?: number;
}): Promise<{ id: string; key: string }> {
  const { key, prefix, hash } = generatePartnerKey();
  const { data, error } = await db()
    .from("partner_api_keys")
    .insert({
      partner_id: input.partnerId,
      key_prefix: prefix,
      key_hash: hash,
      scopes: input.scopes,
      rate_per_minute: input.ratePerMinute,
      monthly_quota: input.monthlyQuota,
    })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id as string, key };
}

/** Issues a replacement with the same scopes/quotas; the old key keeps working for `overlapMs`. */
export async function rotatePartnerKey(
  oldKeyId: string,
  overlapMs = DEFAULT_ROTATION_OVERLAP_MS,
): Promise<{ id: string; key: string }> {
  const client = db();
  const { data: old, error } = await client
    .from("partner_api_keys")
    .select("partner_id, scopes, rate_per_minute, monthly_quota")
    .eq("id", oldKeyId)
    .is("revoked_at", null)
    .single();
  if (error) throw error;
  const issued = await issuePartnerKey({
    partnerId: old.partner_id,
    scopes: old.scopes,
    ratePerMinute: old.rate_per_minute,
    monthlyQuota: old.monthly_quota,
  });
  const { error: expireError } = await client
    .from("partner_api_keys")
    .update({ expires_at: new Date(Date.now() + overlapMs).toISOString() })
    .eq("id", oldKeyId);
  if (expireError) throw expireError;
  return issued;
}

/** Resolves a bearer partner key to an active key record, or null. */
export async function authenticatePartnerKey(request: Request): Promise<PartnerKey | null> {
  const match = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  if (!match || !PARTNER_KEY_PATTERN.test(match[1])) return null;

  const { data } = await db()
    .from("partner_api_keys")
    .select("id, partner_id, scopes, rate_per_minute, monthly_quota, expires_at, revoked_at")
    .eq("key_hash", hashPartnerKey(match[1]))
    .maybeSingle();
  if (!data || data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;

  return {
    id: data.id,
    partnerId: data.partner_id,
    scopes: data.scopes ?? [],
    ratePerMinute: data.rate_per_minute,
    monthlyQuota: data.monthly_quota,
  };
}

export async function consumePartnerQuota(key: PartnerKey): Promise<QuotaDecision> {
  const { data, error } = await db().rpc("partner_api_consume", { p_key_id: key.id });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as {
    allowed: boolean;
    minute_remaining: number;
    month_remaining: number;
    minute_reset: string;
    month_reset: string;
  };

  // Report whichever window is tighter.
  const minuteTighter = row.minute_remaining === 0 || row.month_remaining > row.minute_remaining;
  const reset = new Date(minuteTighter ? row.minute_reset : row.month_reset);
  const resetSeconds = Math.max(1, Math.ceil((reset.getTime() - Date.now()) / MS_PER_SECOND));
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(minuteTighter ? key.ratePerMinute : key.monthlyQuota),
    "RateLimit-Remaining": String(minuteTighter ? row.minute_remaining : row.month_remaining),
    "RateLimit-Reset": String(resetSeconds),
  };
  if (!row.allowed) {
    const blockedReset = row.month_remaining === 0 ? new Date(row.month_reset) : new Date(row.minute_reset);
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil((blockedReset.getTime() - Date.now()) / MS_PER_SECOND)),
    );
  }
  return { allowed: row.allowed, headers };
}

export function statusClass(status: number): "2xx" | "3xx" | "4xx" | "5xx" {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/**
 * Records one request. `endpoint` must be the route template (e.g.
 * "/api/attestation/[recordHash]"), never the concrete path, so no record
 * hash or other identifier ends up in usage data. Best-effort: metering
 * failures never fail the partner's request.
 */
export async function recordPartnerUsage(keyId: string, endpoint: string, status: number): Promise<void> {
  await db()
    .rpc("partner_api_record_usage", {
      p_key_id: keyId,
      p_endpoint: endpoint,
      p_status_class: statusClass(status),
    })
    .then(
      () => undefined,
      () => undefined,
    );
}

export interface UsageRow {
  key_id: string;
  period: string;
  endpoint: string;
  status_class: string;
  count: number;
}

export async function loadUsage(filter: { period: string; partnerId?: string }): Promise<UsageRow[]> {
  const client = db();
  let keyIds: string[] | null = null;
  if (filter.partnerId) {
    const { data, error } = await client.from("partner_api_keys").select("id").eq("partner_id", filter.partnerId);
    if (error) throw error;
    keyIds = (data ?? []).map((k) => k.id as string);
    if (keyIds.length === 0) return [];
  }
  let query = client
    .from("partner_api_usage")
    .select("key_id, period, endpoint, status_class, count")
    .eq("period", filter.period);
  if (keyIds) query = query.in("key_id", keyIds);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as UsageRow[];
}
