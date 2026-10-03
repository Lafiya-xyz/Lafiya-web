import { logError, logInfo, logWarn } from "@/lib/logging/logger";

import type {
  AttestationSource,
  PayoutIndexerStore,
  PayoutIndexerSummary,
  PayoutSource,
} from "./types";

/**
 * Durable queue abstraction used to move background work off the cron-triggered
 * HTTP route and onto Supabase Queues (pgmq). Handlers are idempotent, keyed by
 * the event ID, so at-least-once delivery is safe.
 */
export interface IndexerQueue {
  /** Enqueue a batch of work. Returns the pgmq message ID. */
  enqueue(queue: string, payload: Record<string, unknown>): Promise<number>;
  /** Read a message with a visibility timeout (seconds). */
  read<T>(queue: string, visibilityTimeoutSeconds: number): Promise<IndexerQueueMessage<T> | null>;
  /** Archive a successfully processed message. */
  archive(queue: string, messageId: number): Promise<void>;
  /** Extend the visibility timeout for a message still being processed. */
  setVisibilityTimeout(queue: string, messageId: number, seconds: number): Promise<void>;
  /** Move a poison message to the dead-letter queue after N attempts. */
  deadLetter(queue: string, messageId: number, reason: string): Promise<void>;
}

export interface IndexerQueueMessage<T> {
  messageId: number;
  readCount: number;
  payload: T;
}

export interface IndexerBatchPayload {
  /** Stable event ID used for idempotency. */
  eventId: string;
  kind: "attestations" | "payments";
  cursor: string;
  startLedger: number;
}

const MAX_ATTEMPTS = 5;
const VISIBILITY_TIMEOUT_SECONDS = 60;

export class PayoutIndexer {
  constructor(
    private readonly store: PayoutIndexerStore,
    private readonly attestations: AttestationSource,
    private readonly payouts: PayoutSource,
    private readonly startLedger: number,
    private readonly startPaymentCursor = "0",
    private readonly queue?: IndexerQueue,
  ) {}

  /**
   * Enqueue a single indexing batch instead of running the indexer inline.
   * The cron route calls this so long catch-up runs are not bound by the
   * serverless function timeout.
   */
  async enqueueBatch(kind: "attestations" | "payments", cursor: string): Promise<number> {
    if (!this.queue) {
      throw new Error("IndexerQueue is required to enqueue batches");
    }

    const payload: IndexerBatchPayload = {
      eventId: `${kind}:${cursor}`,
      kind,
      cursor,
      startLedger: this.startLedger,
    };

    return this.queue.enqueue("indexer_batches", payload as unknown as Record<string, unknown>);
  }

  /**
   * Consume a single batch from the durable queue with a visibility timeout.
   * Idempotent: re-delivered messages are keyed by eventId and skipped if the
   * checkpoint already advanced past the batch cursor.
   */
  async consumeBatch(): Promise<PayoutIndexerSummary | null> {
    if (!this.queue) {
      throw new Error("IndexerQueue is required to consume batches");
    }

    const message = await this.queue.read<IndexerBatchPayload>(
      "indexer_batches",
      VISIBILITY_TIMEOUT_SECONDS,
    );

    if (!message) {
      return null;
    }

    const { eventId, kind, cursor } = message.payload;

    try {
      // Idempotency guard: if the checkpoint already advanced past this cursor,
      // the batch was processed by a previous delivery. Archive and move on.
      const checkpoint = await this.store.getCursor(kind);
      if (checkpoint === cursor) {
        logInfo("Indexer batch already processed; skipping", { eventId, kind, cursor });
        await this.queue.archive("indexer_batches", message.messageId);
        return null;
      }

      const summary = await this.runOnce();

      await this.queue.archive("indexer_batches", message.messageId);
      return summary;
    } catch (error) {
      logError("Indexer batch processing failed", error);

      if (message.readCount >= MAX_ATTEMPTS) {
        await this.queue.deadLetter(
          "indexer_batches",
          message.messageId,
          error instanceof Error ? error.message : "unknown error",
        );
        return null;
      }

      // Extend the visibility timeout so the message is retried later.
      await this.queue.setVisibilityTimeout(
        "indexer_batches",
        message.messageId,
        VISIBILITY_TIMEOUT_SECONDS,
      );
      throw error;
    }
  }

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
