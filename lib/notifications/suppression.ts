/**
 * Email bounce / complaint handling and suppression list (issue #802).
 *
 * Hard bounces and complaints suppress an address permanently (until manual
 * release); soft bounces suppress temporarily once they repeat. Addresses are
 * stored only as a SHA-256 hash of the normalized address.
 */

import { createHash, createHmac, timingSafeEqual } from "crypto";

export type SuppressionReason = "hard_bounce" | "soft_bounce" | "complaint";

export interface SuppressionRecord {
  reason: SuppressionReason;
  softCount: number;
  expiresAt: Date | null;
  releasedAt: Date | null;
}

/** Soft bounces tolerated before the address is temporarily suppressed. */
export const SOFT_BOUNCE_THRESHOLD = 3;
export const SOFT_BOUNCE_SUPPRESSION_MS = 72 * 60 * 60 * 1000;

/**
 * Templates that may still be sent to a suppressed address. Policy: only
 * soft-bounce suppressions are bypassed, and only for security notices the
 * patient must receive. Complaints and hard bounces are never bypassed.
 */
export const TRANSACTIONAL_EXCEPTIONS: ReadonlySet<string> = new Set([
  "security.new_signin",
]);

export function hashAddress(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex");
}

/** Constant-time HMAC-SHA256 (hex or base64) signature check over the raw body. */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  const mac = createHmac("sha256", secret).update(rawBody);
  const digest = mac.digest();
  const candidates = [digest.toString("hex"), digest.toString("base64")];
  const given = Buffer.from(signature.replace(/^sha256=/, ""));
  return candidates.some((c) => {
    const expected = Buffer.from(c);
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

export interface EmailEvent {
  type: "bounce" | "complaint";
  bounceType?: "hard" | "soft";
  email: string;
}

/** Normalize a provider event (SendGrid / Postmark / SES-style) into an EmailEvent. */
export function classifyEmailEvent(raw: Record<string, unknown>): EmailEvent | null {
  const email = String(raw.email ?? raw.Email ?? raw.recipient ?? "");
  if (!email) return null;
  const kind = String(raw.event ?? raw.RecordType ?? raw.type ?? "").toLowerCase();
  if (kind.includes("spam") || kind.includes("complaint")) {
    return { type: "complaint", email };
  }
  if (kind.includes("bounce") || kind === "dropped") {
    const sub = String(raw.bounce_classification ?? raw.Type ?? raw.bounceType ?? raw.type ?? "").toLowerCase();
    const soft = sub.includes("soft") || sub.includes("transient") || sub.includes("deferred");
    return { type: "bounce", bounceType: soft ? "soft" : "hard", email };
  }
  return null;
}

/** Fold a new event into an existing suppression record (pure). */
export function applyEmailEvent(
  existing: SuppressionRecord | null,
  event: EmailEvent,
  now: Date = new Date(),
): SuppressionRecord {
  if (event.type === "complaint") {
    return { reason: "complaint", softCount: existing?.softCount ?? 0, expiresAt: null, releasedAt: null };
  }
  if (event.bounceType === "hard") {
    return { reason: "hard_bounce", softCount: existing?.softCount ?? 0, expiresAt: null, releasedAt: null };
  }
  // Soft bounce never downgrades a permanent suppression.
  if (existing && existing.reason !== "soft_bounce" && !existing.releasedAt) return existing;
  const softCount = (existing?.releasedAt ? 0 : existing?.softCount ?? 0) + 1;
  return {
    reason: "soft_bounce",
    softCount,
    expiresAt: softCount >= SOFT_BOUNCE_THRESHOLD ? new Date(now.getTime() + SOFT_BOUNCE_SUPPRESSION_MS) : null,
    releasedAt: null,
  };
}

/** Whether a record currently blocks sending (pure). */
export function isActiveSuppression(record: SuppressionRecord | null, now: Date = new Date()): boolean {
  if (!record || record.releasedAt) return false;
  if (record.reason === "soft_bounce") {
    return record.expiresAt !== null && record.expiresAt.getTime() > now.getTime();
  }
  return true;
}

/** Decide whether a send is allowed, applying the transactional exception policy. */
export function canSendEmail(
  record: SuppressionRecord | null,
  template: string,
  now: Date = new Date(),
): boolean {
  if (!isActiveSuppression(record, now)) return true;
  return record!.reason === "soft_bounce" && TRANSACTIONAL_EXCEPTIONS.has(template);
}

/** Manual release by support staff (pure). */
export function releaseSuppression(record: SuppressionRecord, now: Date = new Date()): SuppressionRecord {
  return { ...record, releasedAt: now };
}

type Row = {
  reason: SuppressionReason;
  soft_count: number;
  expires_at: string | null;
  released_at: string | null;
};

export function fromRow(row: Row | null): SuppressionRecord | null {
  if (!row) return null;
  return {
    reason: row.reason,
    softCount: row.soft_count,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    releasedAt: row.released_at ? new Date(row.released_at) : null,
  };
}

export function toRow(hash: string, r: SuppressionRecord) {
  return {
    address_hash: hash,
    reason: r.reason,
    soft_count: r.softCount,
    expires_at: r.expiresAt?.toISOString() ?? null,
    released_at: r.releasedAt?.toISOString() ?? null,
    updated_at: new Date().toISOString(),
  };
}
