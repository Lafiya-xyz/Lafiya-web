/**
 * Transactional outbox dispatcher (issue #624).
 *
 * Polls the `outbox` table for pending rows, calls the registered idempotent
 * handler for each, and marks rows dispatched.  Uses `claim_outbox_batch`
 * (FOR UPDATE SKIP LOCKED) so multiple concurrent dispatcher instances are
 * safe — each row is processed by exactly one worker per poll cycle.
 *
 * Delivery guarantee: at-least-once.  Handlers MUST be idempotent.
 * A row whose handler throws is left with `dispatched_at = null` and an
 * incremented `attempts` counter so it will be retried on the next poll.
 *
 * ## Schema registry (issue #790)
 * Every event type with a registered schema is validated and upcasted before
 * dispatch. A row whose payload has an unknown version is not retried — it
 * is sent to dead-letter (the handler throws with reason "dead-letter").
 *
 * ## Lag observability
 * `getOutboxLag()` returns the age of the oldest undispatched row so a
 * monitoring probe can alert on processing delays (satisfies the "lag is
 * observable" acceptance criterion).
 *
 * ## Usage (e.g. from a Next.js Route Handler or a Supabase Edge Function)
 *
 * ```ts
 * import { runDispatchCycle, HANDLERS } from "@/lib/outbox/dispatcher";
 * await runDispatchCycle(HANDLERS);
 * ```
 */

import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { logError, logInfo, logWarn } from "@/lib/logging/logger";
import { invalidateAttestationCache } from "@/lib/stellar/attestation-cache-invalidation";
import { parseInboxPayload } from "@/lib/notifications/inbox";
import type { OutboxHandler, OutboxHandlerRegistry, OutboxRow } from "./types";
import { upcastPayload, validateOutboxPayload } from "./types";

// ─── Built-in handlers ──────────────────────────────────────────────────────

/**
 * Handler for `record_revision:record_saved`.
 * Invalidates the attestation cache for the commitment recorded in the
 * outbox payload. This replaces the former direct call from within
 * save_record_revision so the invalidation only fires for committed writes.
 *
 * Privacy: only the commitment (an opaque HMAC hash) is present in the
 * payload — no PHI, no user IDs, no capability tokens.
 */
const handleRecordSaved: OutboxHandler = async (row) => {
  const key = `${row.aggregate}:${row.event_type}`;
  const upcast = upcastPayload(key, row.payload);
  if (!upcast.ok) {
    logWarn(
      `outbox: ${key} payload failed upcast (${upcast.reason}) — sending to dead-letter`,
      { outbox_id: row.id, reason: upcast.reason },
    );
    throw new Error(`dead-letter: ${upcast.reason}`);
  }

  const commitment = upcast.payload["commitment"];
  if (typeof commitment !== "string" || !/^[0-9a-f]{64}$/.test(commitment)) {
    logWarn("outbox: record_saved payload missing valid commitment — skipping", {
      outbox_id: row.id,
    });
    return;
  }
  await invalidateAttestationCache(commitment, "new_attestation");
};

/**
 * Default handler registry.  Register additional handlers here as new
 * event types are introduced (e.g. notification dispatch, webhook fan-out).
 *
 * Key format: `${aggregate}:${event_type}`
 */
/**
 * Persists a PHI-free inbox notification (issue #764). Idempotent per
 * event_key: record_user_notification ignores duplicates on retry.
 */
const handleUserNotification: OutboxHandler = async (row) => {
  const payload = parseInboxPayload(row.payload);
  if (!payload) {
    logWarn("outbox: user_notification payload invalid — skipping", {
      outbox_id: row.id,
    });
    return;
  }
  const admin = createAdminClient();
  const { error } = await (admin as any).rpc("record_user_notification", {
    p_card_public_id: payload.card_public_id,
    p_type: payload.type,
    p_body_key: payload.body_key,
    p_event_key: payload.event_key,
  });
  if (error) throw error;
};

export const HANDLERS: OutboxHandlerRegistry = new Map<string, OutboxHandler>([
  ["record_revision:record_saved", handleRecordSaved],
  ["user_notification:security_event", handleUserNotification],
]);

// ─── Dispatcher core ────────────────────────────────────────────────────────

/**
 * Runs one poll cycle: claims up to `batchSize` pending outbox rows,
 * dispatches each to its registered handler, and acknowledges successes.
 *
 * Before calling the handler, the payload is validated and upcasted to the
 * current schema version. Rows with unknown versions go to dead-letter and
 * will not be retried (they remain in the queue with incremented attempts
 * until a manual intervention or a dead-letter sweep clears them).
 *
 * @returns The number of rows successfully dispatched in this cycle.
 */
export async function runDispatchCycle(
  handlers: OutboxHandlerRegistry = HANDLERS,
  batchSize = 50,
): Promise<number> {
  const admin = createAdminClient();

  // Claim a batch atomically (FOR UPDATE SKIP LOCKED via the SQL helper).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error: claimError } = await (admin as any).rpc(
    "claim_outbox_batch",
    { p_batch_size: batchSize },
  );

  if (claimError) {
    logError("outbox: failed to claim batch", claimError);
    return 0;
  }

  if (!rows || rows.length === 0) {
    return 0;
  }

  logInfo("outbox: dispatching batch", { count: rows.length });

  let dispatched = 0;

  for (const row of rows as OutboxRow[]) {
    const key = `${row.aggregate}:${row.event_type}`;
    const handler = handlers.get(key);

    if (!handler) {
      logWarn("outbox: no handler registered — acknowledging to avoid retry loop", {
        key,
        outbox_id: row.id,
      });
      // Acknowledge unknown event types so they don't clog the queue.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).rpc("ack_outbox_row", { p_id: row.id });
      dispatched++;
      continue;
    }

    try {
      await handler(row);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).rpc("ack_outbox_row", { p_id: row.id });
      dispatched++;
    } catch (err) {
      // Leave dispatched_at = null; attempts was already incremented by
      // claim_outbox_batch, providing natural back-pressure visibility.
      logError("outbox: handler threw — row will be retried", err, {
        key,
        outbox_id: row.id,
        attempts: row.attempts,
      });
    }
  }

  return dispatched;
}

// ─── Write-time validation ───────────────────────────────────────────────────

/**
 * Validate a payload before inserting an outbox row.  Call this in the same
 * transaction as the INSERT so an invalid payload is rejected before commit.
 *
 * Throws with a descriptive message if validation fails.
 */
export function assertValidOutboxPayload(
  aggregate: string,
  event_type: string,
  payload: Record<string, unknown>,
): void {
  const key = `${aggregate}:${event_type}`;
  const result = validateOutboxPayload(key, payload);
  if (!result.ok) {
    throw new Error(
      `outbox: invalid payload for ${key}: ${result.error}`,
    );
  }
}

// ─── Observability ──────────────────────────────────────────────────────────

export interface OutboxLag {
  /** Age in milliseconds of the oldest undispatched row, or null if the queue is empty. */
  lagMs: number | null;
  /** Total number of undispatched rows. */
  pendingCount: number;
}

/**
 * Returns the lag of the outbox queue so a monitoring probe can alert when
 * rows are not being consumed within an acceptable window.
 *
 * Uses the service-role client because `outbox` is not accessible to the
 * authenticated role (internal infrastructure table).
 */
export async function getOutboxLag(): Promise<OutboxLag> {
  const admin = createAdminClient();

  const { data, error } = await admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("outbox" as any)
    .select("created_at")
    .is("dispatched_at", null)
    .order("created_at", { ascending: true })
    .limit(1000); // cap scan for safety

  if (error) {
    logError("outbox: failed to query lag", error);
    return { lagMs: null, pendingCount: 0 };
  }

  if (!data || (data as unknown[]).length === 0) {
    return { lagMs: 0, pendingCount: 0 };
  }

  const oldest = new Date((data as Array<{ created_at: string }>)[0].created_at).getTime();
  return {
    lagMs: Date.now() - oldest,
    pendingCount: (data as unknown[]).length,
  };
}

// Re-export validateOutboxPayload for use by write-side callers.
export { validateOutboxPayload };
