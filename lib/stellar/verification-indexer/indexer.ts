import { logError, logInfo } from "@/lib/logging/logger";

import type {
  FinalizedAttestationEvent,
  VerificationEvidenceStore,
  VerificationEventSource,
} from "./types";

function invalidReason(event: FinalizedAttestationEvent): string | null {
  if (!event.eventId || !event.intentId || !event.transactionHash)
    return "MALFORMED_EVENT";
  if (
    !/^[0-9a-f]{64}$/i.test(event.recordCommitment) ||
    !event.attesterAddress
  ) {
    return "MALFORMED_EVENT";
  }
  if (!Number.isSafeInteger(event.ledgerSequence) || event.ledgerSequence < 1) {
    return "MALFORMED_EVENT";
  }
  if (!Number.isSafeInteger(event.eventIndex) || event.eventIndex < 0) {
    return "MALFORMED_EVENT";
  }
  if (!/^[0-9a-f]{64}$/i.test(event.networkPassphraseHash)) {
    return "MALFORMED_EVENT";
  }
  return null;
}

/**
 * Optional archival backfill adapter. Soroban RPC only retains events for a
 * limited window, so when the checkpoint falls behind the RPC's oldest
 * retained ledger the indexer must refuse to advance and hand the gap to an
 * archival source (e.g. Hubble/BigQuery export or a self-hosted archival RPC).
 */
export interface BackfillAdapter {
  /** Human-readable identifier for the archival source. */
  readonly name: string;
  /**
   * Fetch events for the inclusive ledger range [fromLedger, toLedger].
   * Implementations must return events in ascending ledger/event order.
   */
  readRange(
    fromLedger: number,
    toLedger: number,
  ): Promise<{ events: FinalizedAttestationEvent[]; cursor: string }>;
}

/**
 * At-least-once ledger worker. It deliberately saves the cursor only after
 * every event has either been atomically applied or durably quarantined. A
 * crash before that point replays a stable event identity into idempotent SQL.
 *
 * Before applying any events it compares the persisted checkpoint ledger with
 * the RPC's retention boundary. If the checkpoint predates the oldest ledger
 * the RPC still serves, the run enters GAP_DETECTED: no events are applied,
 * the incident is recorded, and the state is surfaced for readiness checks.
 */
export class VerificationIndexer {
  constructor(
    private readonly store: VerificationEvidenceStore,
    private readonly source: VerificationEventSource,
    private readonly backfill?: BackfillAdapter,
  ) {}

  async runOnce(): Promise<{
    applied: number;
    quarantined: number;
    cursor: string;
    gapDetected: boolean;
  }> {
    try {
      const cursor = await this.store.getCursor();
      const checkpointLedger = await this.store.getCheckpointLedger();
      const { latestLedger, oldestLedger } =
        await this.source.getRetentionWindow();

      if (checkpointLedger < oldestLedger) {
        const gap = {
          checkpointLedger,
          oldestLedger,
          latestLedger,
          missingLedgers: oldestLedger - checkpointLedger,
        };
        await this.store.recordGapIncident(gap);
        logError(
          "Verification indexer GAP_DETECTED: checkpoint predates RPC retention window",
          gap,
        );
        return {
          applied: 0,
          quarantined: 0,
          cursor,
          gapDetected: true,
        };
      }

      const page = await this.source.read(cursor);
      let applied = 0;
      let quarantined = 0;
      for (const event of page.events) {
        const reason = invalidReason(event);
        if (reason) {
          await this.store.quarantine(event.eventId || "invalid-event", reason);
          quarantined += 1;
        } else {
          await this.store.applyFinalized(event);
          applied += 1;
        }
      }
      await this.store.saveCursor(page.cursor);
      logInfo("Verification indexer run completed", { applied, quarantined });
      return { applied, quarantined, cursor: page.cursor, gapDetected: false };
    } catch (error) {
      logError("Verification indexer run failed", error);
      throw error;
    }
  }

  /**
   * Backfill a detected gap from the configured archival adapter. Returns the
   * number of events applied, or throws when no adapter is configured.
   */
  async backfillGap(): Promise<{ applied: number; cursor: string }> {
    if (!this.backfill) {
      throw new Error(
        "No backfill adapter configured; cannot recover from GAP_DETECTED",
      );
    }
    const checkpointLedger = await this.store.getCheckpointLedger();
    const { oldestLedger } = await this.source.getRetentionWindow();
    const { events, cursor } = await this.backfill.readRange(
      checkpointLedger + 1,
      oldestLedger - 1,
    );
    let applied = 0;
    for (const event of events) {
      const reason = invalidReason(event);
      if (reason) {
        await this.store.quarantine(event.eventId || "invalid-event", reason);
      } else {
        await this.store.applyFinalized(event);
        applied += 1;
      }
    }
    await this.store.saveCursor(cursor);
    logInfo("Verification indexer gap backfill completed", {
      applied,
      source: this.backfill.name,
    });
    return { applied, cursor };
  }
}
