/**
 * Issue #808: admin audit explorer -- bounded filters, role-based
 * redaction, and signed export over the `audit_events` projection.
 *
 * Every query (search and export alike) must carry a justification and is
 * recorded in `audit_explorer_queries` before results are returned.
 */

import { createHash } from "node:crypto";

export const MAX_RANGE_DAYS = 31;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const AUDIT_SOURCES = ["card_access", "consent", "break_glass", "contract_admin"] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];
export type AdminRole = "auditor" | "support" | "analyst";

export interface AuditEvent {
  source: AuditSource;
  event_id: string;
  occurred_at: string;
  actor: string;
  subject_user_id: string | null;
  action: string;
  correlation_id: string | null;
  detail: Record<string, unknown> | null;
}

export interface AuditFilters {
  from: Date;
  to: Date;
  actor?: string;
  action?: string;
  correlationId?: string;
  subjectUserId?: string;
  page: number;
  pageSize: number;
}

export type ParseResult =
  | { ok: true; filters: AuditFilters; justification: string }
  | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAuditQuery(params: URLSearchParams): ParseResult {
  const from = new Date(params.get("from") ?? "");
  const to = new Date(params.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return { ok: false, error: "from and to must be ISO timestamps with from < to" };
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    return { ok: false, error: `time range may not exceed ${MAX_RANGE_DAYS} days` };
  }
  const justification = (params.get("justification") ?? "").trim();
  if (justification.length < 10 || justification.length > 500) {
    return { ok: false, error: "justification (10-500 chars) is required" };
  }
  const subjectUserId = params.get("subject") ?? undefined;
  if (subjectUserId !== undefined && !UUID.test(subjectUserId)) {
    return { ok: false, error: "subject must be a user UUID" };
  }
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(params.get("pageSize") ?? "", 10) || DEFAULT_PAGE_SIZE),
  );
  return {
    ok: true,
    justification,
    filters: {
      from,
      to,
      actor: params.get("actor") ?? undefined,
      action: params.get("action") ?? undefined,
      correlationId: params.get("correlationId") ?? undefined,
      subjectUserId,
      page,
      pageSize,
    },
  };
}

/** Stable pseudonym so redacted rows can still be correlated with each other. */
export function pseudonymize(value: string): string {
  return `pseud_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Redaction per role:
 *  - auditor: full row.
 *  - support: subject pseudonymized; break-glass reason and disclosed
 *    fields removed from detail.
 *  - analyst: subject and actor pseudonymized; detail and correlation ID
 *    removed entirely (aggregate/trend use only).
 */
export function redactEvent(event: AuditEvent, role: AdminRole): AuditEvent {
  if (role === "auditor") return event;
  const subject = event.subject_user_id ? pseudonymize(event.subject_user_id) : null;
  if (role === "support") {
    const detail = event.detail ? { ...event.detail } : null;
    if (detail) {
      delete detail.reason;
      delete detail.fields_disclosed;
    }
    return { ...event, subject_user_id: subject, detail };
  }
  return {
    ...event,
    actor: pseudonymize(event.actor),
    subject_user_id: subject,
    correlation_id: null,
    detail: null,
  };
}

const CSV_COLUMNS: (keyof AuditEvent)[] = [
  "source",
  "event_id",
  "occurred_at",
  "actor",
  "subject_user_id",
  "action",
  "correlation_id",
  "detail",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeAuditCsv(events: AuditEvent[]): string {
  return (
    [CSV_COLUMNS.join(","), ...events.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(","))].join(
      "\n",
    ) + "\n"
  );
}

export function serializeAuditJson(events: AuditEvent[]): string {
  return JSON.stringify(events.map((e) => Object.fromEntries(CSV_COLUMNS.map((c) => [c, e[c] ?? null]))));
}
