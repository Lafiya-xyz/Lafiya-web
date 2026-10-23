/**
 * Shared types for the transactional outbox (issue #624 and #688).
 *
 * All values stored in `outbox.payload` must be opaque identifiers only —
 * no PHI, no capability tokens, no raw user IDs. Use commitment hashes,
 * revision UUIDs, and hashed identifiers.
 */

export type OutboxStatus = "pending" | "dispatched" | "dead";

export interface OutboxRow {
  id: string;
  aggregate: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  dispatched_at: string | null;
  attempts: number;
  /** Earliest time the dispatcher may claim this pending row again. */
  next_attempt_at: string;
  /** Sanitized, PHI-free reason for the most recent handler failure. */
  last_error: string | null;
  /** Terminal `dead` rows are only retried after an operator requeue. */
  status: OutboxStatus;
  /** Set when the row entered the terminal dead state. */
  dead_at: string | null;
}

/**
 * Each handler receives one outbox row and must be idempotent: calling it
 * twice for the same row must produce the same observable outcome as calling
 * it once. The dispatcher guarantees at-least-once delivery.
 */
export type OutboxHandler = (row: OutboxRow) => Promise<void>;

/** Registry mapping `${aggregate}:${event_type}` to a handler. */
export type OutboxHandlerRegistry = Map<string, OutboxHandler>;
