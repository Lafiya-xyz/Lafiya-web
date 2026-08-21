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
 * At-least-once ledger worker. It deliberately saves the cursor only after
 * every event has either been atomically applied or durably quarantined. A
 * crash before that point replays a stable event identity into idempotent SQL.
 */
export class VerificationIndexer {
  constructor(
    private readonly store: VerificationEvidenceStore,
    private readonly source: VerificationEventSource,
  ) {}

  async runOnce(): Promise<{
    applied: number;
    quarantined: number;
    cursor: string;
  }> {
    try {
      const cursor = await this.store.getCursor();
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
      return { applied, quarantined, cursor: page.cursor };
    } catch (error) {
      logError("Verification indexer run failed", error);
      throw error;
    }
  }
}
