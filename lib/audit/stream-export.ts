/**
 * Issue #884: bounded-memory streaming exports for the admin audit explorer.
 *
 * Rows are pulled from Postgres with keyset pagination (never OFFSET) and
 * pushed through a ReadableStream one batch at a time, so peak memory is
 * O(batch size) rather than O(result set). Redaction is delegated to the
 * shared `redactEvent` used by the non-streaming path, so both paths apply
 * identical rules.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  redactEvent,
  type AdminRole,
  type AuditEvent,
  type AuditFilters,
} from "@/lib/audit/explorer";

/** Rows fetched per keyset page. Small enough to keep RSS flat. */
export const STREAM_BATCH_SIZE = 500;

export type ExportFormat = "csv" | "json" | "ndjson";

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

/** One redacted row as a CSV line (no trailing newline). */
export function auditCsvRow(event: AuditEvent): string {
  return CSV_COLUMNS.map((c) => csvCell(event[c])).join(",");
}

/** One redacted row as a JSON object with the stable column ordering. */
export function auditJsonRow(event: AuditEvent): Record<string, unknown> {
  return Object.fromEntries(CSV_COLUMNS.map((c) => [c, event[c] ?? null]));
}

export function auditCsvHeader(): string {
  return CSV_COLUMNS.join(",");
}

export interface AuditKeysetCursor {
  occurredAt: string;
  eventId: string;
}

export interface AuditStreamOptions {
  db: SupabaseClient;
  filters: AuditFilters;
  role: AdminRole;
  format: ExportFormat;
  batchSize?: number;
  /** Called once with the total number of rows streamed (for the query log). */
  onComplete?: (rowCount: number) => Promise<void> | void;
}

/**
 * Keyset page fetch: `(occurred_at, event_id) < (cursor)` in descending
 * order. `event_id` breaks ties so no row is skipped or repeated when many
 * events share a timestamp.
 */
async function fetchAuditBatch(
  db: SupabaseClient,
  filters: AuditFilters,
  cursor: AuditKeysetCursor | null,
  limit: number,
): Promise<AuditEvent[]> {
  let query = db
    .from("audit_events")
    .select("*")
    .gte("occurred_at", filters.from.toISOString())
    .lt("occurred_at", filters.to.toISOString())
    .order("occurred_at", { ascending: false })
    .order("event_id", { ascending: false })
    .limit(limit);
  if (filters.actor) query = query.eq("actor", filters.actor);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.correlationId) query = query.eq("correlation_id", filters.correlationId);
  if (filters.subjectUserId) query = query.eq("subject_user_id", filters.subjectUserId);
  if (cursor) {
    query = query.or(
      `occurred_at.lt.${cursor.occurredAt},and(occurred_at.eq.${cursor.occurredAt},event_id.lt.${cursor.eventId})`,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`audit stream query failed: ${error.message}`);
  return (data ?? []) as AuditEvent[];
}

/**
 * Streams the redacted audit export. Memory stays bounded by `batchSize`
 * regardless of how many rows match the filters.
 */
export function streamAuditExport(options: AuditStreamOptions): ReadableStream<Uint8Array> {
  const { db, filters, role, format } = options;
  const batchSize = options.batchSize ?? STREAM_BATCH_SIZE;
  const encoder = new TextEncoder();

  let cursor: AuditKeysetCursor | null = null;
  let done = false;
  let rowCount = 0;
  let headerSent = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) return;
      try {
        const batch = await fetchAuditBatch(db, filters, cursor, batchSize);
        if (batch.length === 0) {
          done = true;
          if (format === "json") controller.enqueue(encoder.encode("[]"));
          await options.onComplete?.(rowCount);
          controller.close();
          return;
        }

        const last = batch[batch.length - 1];
        cursor = { occurredAt: last.occurred_at, eventId: last.event_id };
        if (batch.length < batchSize) done = true;

        const redacted = batch.map((event) => redactEvent(event, role));
        rowCount += redacted.length;

        let chunk = "";
        if (format === "csv") {
          if (!headerSent) {
            chunk += auditCsvHeader() + "\n";
            headerSent = true;
          }
          chunk += redacted.map((e) => auditCsvRow(e) + "\n").join("");
        } else if (format === "ndjson") {
          chunk += redacted.map((e) => JSON.stringify(auditJsonRow(e)) + "\n").join("");
        } else {
          // JSON array: emit the opening bracket once, then comma-separated rows.
          chunk += (headerSent ? "," : "[") + redacted.map((e) => JSON.stringify(auditJsonRow(e))).join(",");
          headerSent = true;
        }
        controller.enqueue(encoder.encode(chunk));

        if (done) {
          if (format === "json") controller.enqueue(encoder.encode("]"));
          await options.onComplete?.(rowCount);
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

export function exportContentType(format: ExportFormat): string {
  if (format === "csv") return "text/csv; charset=utf-8";
  if (format === "ndjson") return "application/x-ndjson; charset=utf-8";
  return "application/json; charset=utf-8";
}
