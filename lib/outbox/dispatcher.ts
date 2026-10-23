/**
 * Transactional outbox dispatcher (issues #624 and #688).
 *
 * Polls the `outbox` table for due pending rows, calls the registered
 * idempotent handler for each, and marks rows dispatched.  Uses
 * `claim_outbox_batch` (FOR UPDATE SKIP LOCKED) so multiple concurrent
 * dispatcher instances are safe — each row is processed by exactly one worker
 * per poll cycle.
 *
 * Delivery guarantee: at-least-once.  Handlers MUST be idempotent.
 *
 * ## Retry budget and dead-lettering (#688)
 * On failure the dispatcher schedules the next attempt with capped exponential
 * backoff plus full jitter (see `lib/outbox/backoff.ts`).  Each event type has
 * its own policy.  Once `attempts` reaches the policy's `maxAttempts`, the row
 * moves to the terminal `dead` state, emits a structured metric/log event, and
 * stops competing with healthy rows for dispatcher capacity.
 *
 * A handler that keeps throwing therefore cannot be retried forever.  Dead
 * rows are surfaced by `getOutboxLag()` / `/api/internal/readiness`, and the
 * `requeue_dead_outbox_row()` SQL function is the audited operator escape
 * hatch.
 *
 * ## Lag observability
 * `getOutboxLag()` returns the age of the oldest due pending row plus the
 * dead-row count so monitoring can alert on both processing delays and
 * poison events.
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
import { sanitizeOutboxError } from "./error";
import {
  DEFAULT_OUTBOX_RETRY_POLICY,
  OUTBOX_RETRY_POLICIES,
  computeOutboxBackoffMs,
  getOutboxRetryPolicy,
  type OutboxClock,
  type OutboxRandom,
  type OutboxRetryPolicy,
  type OutboxRetryPolicyMap,
} from "./backoff";
import type { OutboxHandler, OutboxHandlerRegistry, OutboxRow } from "./types";

/** Metric name emitted whenever a row exhausts its retry budget. */
export const OUTBOX_DEAD_LETTER_METRIC = "outbox_dead_letter_total";

export { sanitizeOutboxError } from "./error";

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
  const commitment = row.payload["commitment"];
  if (typeof commitment !== "string" || !/^[0-9a-f]{64}$/.test(commitment)) {
    logWarn(
      "outbox: record_saved payload missing valid commitment — skipping",
      {
        outbox_id: row.id,
      },
    );
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
export const HANDLERS: OutboxHandlerRegistry = new Map<string, OutboxHandler>([
  ["record_revision:record_saved", handleRecordSaved],
]);

// ─── Dispatcher core ────────────────────────────────────────────────────────

export interface DispatchCycleOptions {
  /** Maximum rows to claim in this cycle. Ignored for legacy call sites. */
  batchSize?: number;
  /** Per-event retry overrides, keyed by `${aggregate}:${event_type}`. */
  retryPolicies?: OutboxRetryPolicyMap;
  /** Fallback policy for event types without an override. */
  defaultRetryPolicy?: OutboxRetryPolicy;
  /** Injectable jitter source for deterministic tests. */
  random?: OutboxRandom;
  /** Injectable wall clock (epoch ms) for deterministic tests. */
  now?: OutboxClock;
  /** Optional hook used by tests/metrics bridges to observe dead-lettering. */
  onDeadLetter?: (event: {
    row: OutboxRow;
    eventKey: string;
    maxAttempts: number;
    lastError: string;
  }) => void;
}

/**
 * Runs one poll cycle: claims up to `batchSize` due pending outbox rows,
 * dispatches each to its registered handler, and acknowledges successes.
 *
 * @returns The number of rows successfully dispatched in this cycle.
 */
export async function runDispatchCycle(
  handlers: OutboxHandlerRegistry = HANDLERS,
  batchSizeOrOptions: number | DispatchCycleOptions = 50,
  maybeOptions: DispatchCycleOptions = {},
): Promise<number> {
  const options =
    typeof batchSizeOrOptions === "number" ? maybeOptions : batchSizeOrOptions;
  const batchSize =
    typeof batchSizeOrOptions === "number"
      ? batchSizeOrOptions
      : (batchSizeOrOptions.batchSize ?? 50);

  const admin = createAdminClient({ purpose: "outbox" });
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const retryPolicies = options.retryPolicies ?? OUTBOX_RETRY_POLICIES;
  const defaultRetryPolicy =
    options.defaultRetryPolicy ?? DEFAULT_OUTBOX_RETRY_POLICY;

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
      logWarn(
        "outbox: no handler registered — acknowledging to avoid retry loop",
        {
          key,
          outbox_id: row.id,
        },
      );
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
      const policy = getOutboxRetryPolicy(
        key,
        retryPolicies,
        defaultRetryPolicy,
      );
      const lastError = sanitizeOutboxError(err);

      if (row.attempts >= policy.maxAttempts) {
        // Budget exhausted: terminal state. Never retried automatically.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: deadError } = await (admin as any).rpc(
          "dead_letter_outbox_row",
          { p_id: row.id, p_last_error: lastError },
        );

        if (deadError) {
          logError("outbox: failed to dead-letter row", deadError, {
            key,
            outbox_id: row.id,
            attempts: row.attempts,
          });
          continue;
        }

        logWarn("outbox: row moved to dead-letter", {
          metric: OUTBOX_DEAD_LETTER_METRIC,
          metric_value: 1,
          key,
          outbox_id: row.id,
          attempts: row.attempts,
          max_attempts: policy.maxAttempts,
          last_error: lastError,
        });

        options.onDeadLetter?.({
          row,
          eventKey: key,
          maxAttempts: policy.maxAttempts,
          lastError,
        });
        continue;
      }

      const delayMs = computeOutboxBackoffMs(row.attempts, policy, random);
      const nextAttemptAt = new Date(now() + delayMs).toISOString();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: deferError } = await (admin as any).rpc(
        "defer_outbox_row",
        {
          p_id: row.id,
          p_next_attempt_at: nextAttemptAt,
          p_last_error: lastError,
        },
      );

      if (deferError) {
        logError("outbox: failed to schedule retry", deferError, {
          key,
          outbox_id: row.id,
          attempts: row.attempts,
        });
        continue;
      }

      logError("outbox: handler threw — retry scheduled", err, {
        key,
        outbox_id: row.id,
        attempts: row.attempts,
        max_attempts: policy.maxAttempts,
        delay_ms: delayMs,
        next_attempt_at: nextAttemptAt,
      });
    }
  }

  return dispatched;
}

// ─── Observability ──────────────────────────────────────────────────────────

export interface OutboxLag {
  /** Age in milliseconds of the oldest undispatched row, or null if empty. */
  lagMs: number | null;
  /** Total number of pending rows (excluding dead-lettered rows). */
  pendingCount: number;
  /** Number of rows in the terminal dead state. */
  deadCount: number;
}

/**
 * Returns the lag of the outbox queue and the current dead-row count so a
 * monitoring probe can alert when rows are not being consumed within an
 * acceptable window or a poison event has exhausted its retry budget.
 *
 * Only timestamps/status are read — payloads are never selected, so the
 * readiness response cannot leak event data.
 *
 * Uses the service-role client because `outbox` is not accessible to the
 * authenticated role (internal infrastructure table).
 */
export async function getOutboxLag(): Promise<OutboxLag> {
  const admin = createAdminClient({ purpose: "outbox" });

  const { data, error } = await admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("outbox" as any)
    .select("created_at")
    .eq("status", "pending")
    .order("next_attempt_at", { ascending: true })
    .limit(1000); // cap scan for safety

  if (error) {
    logError("outbox: failed to query lag", error);
    return { lagMs: null, pendingCount: 0, deadCount: 0 };
  }

  const { count: deadCount, error: deadError } = await admin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .from("outbox" as any)
    .select("id", { head: true, count: "exact" })
    .eq("status", "dead");

  if (deadError) {
    logError("outbox: failed to query dead-row count", deadError);
  }

  if (!data || (data as unknown[]).length === 0) {
    return { lagMs: 0, pendingCount: 0, deadCount: deadCount ?? 0 };
  }

  const oldest = new Date(
    (data as Array<{ created_at: string }>)[0].created_at,
  ).getTime();
  return {
    lagMs: Date.now() - oldest,
    pendingCount: (data as unknown[]).length,
    deadCount: deadCount ?? 0,
  };
}
