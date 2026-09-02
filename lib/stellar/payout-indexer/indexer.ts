import { logError, logInfo, logWarn } from "@/lib/logging/logger";

import type {
  AttestationSource,
  PayoutIndexerStore,
  PayoutIndexerSummary,
  PayoutSource,
} from "./types";

export class PayoutIndexer {
  constructor(
    private readonly store: PayoutIndexerStore,
    private readonly attestations: AttestationSource,
    private readonly payouts: PayoutSource,
    private readonly startLedger: number,
    private readonly startPaymentCursor = "0",
  ) {}

  async runOnce(): Promise<PayoutIndexerSummary> {
    try {
      // Read both checkpoints before processing to enable reorg detection
      const [attestationCheckpoint, paymentCheckpoint, attestationCursor, paymentCursor] =
        await Promise.all([
          this.store.getLedgerCheckpoint("attestations"),
          this.store.getLedgerCheckpoint("payments"),
          this.store.getCursor("attestations"),
          this.store.getCursor("payments"),
        ]);

      // Fetch both pages in parallel
      const [attestationPage, paymentPage] = await Promise.all([
        this.attestations.read(attestationCursor, this.startLedger),
        this.payouts.read(paymentCursor, this.startPaymentCursor),
      ]);

      // Apply payment events first (they're typically earlier in the flow)
      let paymentConflictCount = 0;
      let maxPaymentLedger = paymentCheckpoint?.ledgerNumber ?? BigInt(0);

      for (const event of paymentPage.events) {
        const result = await this.store.applyPayout(event);

        if (result.reorgDetected) {
          logWarn("Payout event: reorg or provider disagreement detected", {
            recordHash: event.recordHash,
            transactionHash: event.transactionHash,
            pagingToken: event.pagingToken,
          });
          paymentConflictCount++;
        }

        if (result.conflictLogged) {
          paymentConflictCount++;
        }

        logInfo("CHW payout event processed", {
          recordHash: event.recordHash,
          transactionHash: event.transactionHash,
          pagingToken: event.pagingToken,
          decision: result.decision,
          evidenceRecorded: result.evidenceRecorded,
          reorgDetected: result.reorgDetected,
        });

        // Track max ledger for checkpoint (Horizon may not provide ledger_number)
        if (event.ledger) {
          maxPaymentLedger = BigInt(Math.max(Number(maxPaymentLedger), event.ledger));
        }
      }

      // Update payment checkpoint if events were processed
      if (paymentPage.events.length > 0) {
        const lastEvent = paymentPage.events[paymentPage.events.length - 1];
        await this.store.updateLedgerCheckpoint(
          "payments",
          maxPaymentLedger,
          paymentPage.cursor,
          lastEvent.transactionHash,
        );
      }

      // Save legacy cursor for backwards compatibility
      await this.store.saveCursor("payments", paymentPage.cursor);

      // Apply attestation events
      let attestationConflictCount = 0;
      let maxAttestationLedger = attestationCheckpoint?.ledgerNumber ?? BigInt(0);

      for (const event of attestationPage.events) {
        const result = await this.store.applyAttestation(event);

        if (result.reorgDetected) {
          logWarn("Attestation event: reorg detected", {
            recordHash: event.recordHash,
            transactionHash: event.transactionHash,
            ledger: event.ledger,
          });
          attestationConflictCount++;
        }

        if (result.conflictLogged) {
          attestationConflictCount++;
        }

        logInfo("CHW attestation event processed", {
          recordHash: event.recordHash,
          transactionHash: event.transactionHash,
          ledger: event.ledger,
          decision: result.decision,
          evidenceRecorded: result.evidenceRecorded,
          reorgDetected: result.reorgDetected,
        });

        maxAttestationLedger = BigInt(Math.max(Number(maxAttestationLedger), event.ledger));
      }

      // Update attestation checkpoint if events were processed
      if (attestationPage.events.length > 0) {
        const lastEvent = attestationPage.events[attestationPage.events.length - 1];
        await this.store.updateLedgerCheckpoint(
          "attestations",
          maxAttestationLedger,
          attestationPage.cursor,
          lastEvent.transactionHash,
        );
      }

      // Save legacy cursor for backwards compatibility
      await this.store.saveCursor("attestations", attestationPage.cursor);

      // Fetch unresolved conflicts for summary
      const unresolved = await this.store.getConflictingRecords();
      const totalConflicts = paymentConflictCount + attestationConflictCount;

      const summary = {
        attestations: attestationPage.events.length,
        payments: paymentPage.events.length,
        attestationCursor: attestationPage.cursor,
        paymentCursor: paymentPage.cursor,
        attestationCheckpoint: attestationCheckpoint,
        paymentCheckpoint: paymentCheckpoint,
        conflictCount: totalConflicts,
      };

      logInfo("CHW payout indexer run completed", {
        ...summary,
        unresolvedConflicts: unresolved.length,
        totalConflicts,
      });

      return summary;
    } catch (error) {
      logError("CHW payout indexer run failed", error);
      throw error;
    }
  }
}
