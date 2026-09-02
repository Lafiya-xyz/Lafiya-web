import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import type {
  AttestationEvent,
  PayoutEvent,
  PayoutIndexerStore,
  StreamName,
  LedgerAwareApplyResult,
} from "./types";
import type {
  LedgerCheckpoint,
  ConflictingObservation,
} from "./ledger-awareness";
import {
  isLedgerReorgLikely,
  buildConflictObservation,
} from "./ledger-awareness";

function assertNoError(
  error: { message: string } | null,
  operation: string,
): void {
  if (error) throw new Error(`${operation}: ${error.message}`);
}

export class SupabasePayoutIndexerStore implements PayoutIndexerStore {
  constructor(
    private readonly client: SupabaseClient<Database> = createAdminClient(),
  ) {}

  async getCursor(stream: StreamName): Promise<string | null> {
    const { data, error } = await this.client
      .from("stellar_indexer_cursors")
      .select("cursor")
      .eq("stream", stream)
      .maybeSingle();
    assertNoError(error, `read ${stream} cursor`);
    return data?.cursor ?? null;
  }

  async saveCursor(stream: StreamName, cursor: string): Promise<void> {
    const { error } = await this.client
      .from("stellar_indexer_cursors")
      .upsert(
        { stream, cursor, updated_at: new Date().toISOString() },
        { onConflict: "stream" },
      );
    assertNoError(error, `save ${stream} cursor`);
  }

  async getLedgerCheckpoint(stream: StreamName): Promise<LedgerCheckpoint | null> {
    const { data, error } = await this.client.rpc(
      "get_ledger_checkpoint",
      { p_stream: stream },
    );
    assertNoError(error, `get ${stream} ledger checkpoint`);

    if (!data || data.length === 0) {
      return null;
    }

    const row = data[0];
    return {
      ledgerNumber: BigInt(row.ledger_number),
      cursor: row.cursor,
      confirmedAt: new Date(row.confirmed_at),
      lastTxHash: row.last_tx_hash,
    };
  }

  async updateLedgerCheckpoint(
    stream: StreamName,
    ledgerNumber: bigint,
    cursor: string,
    lastTxHash: string | null,
  ): Promise<void> {
    const { error } = await this.client.rpc("update_ledger_checkpoint", {
      p_stream: stream,
      p_ledger_number: ledgerNumber.toString(),
      p_cursor: cursor,
      p_last_tx_hash: lastTxHash,
    });
    assertNoError(error, `update ${stream} ledger checkpoint`);
  }

  async detectLedgerReorg(stream: StreamName, newLedger: bigint): Promise<boolean> {
    const { data, error } = await this.client.rpc("detect_ledger_reorg", {
      p_stream: stream,
      p_new_ledger: newLedger.toString(),
    });
    assertNoError(error, `detect ${stream} ledger reorg`);
    return data === true;
  }

  async recordAttestationEvidence(
    recordHash: string,
    stellarAddress: string,
    ledgerNumber: bigint,
    transactionHash: string,
    attestedAt: string,
    decision: string,
  ): Promise<{ success: boolean; reason: string }> {
    const { data, error } = await this.client.rpc(
      "record_attestation_evidence",
      {
        p_record_hash: recordHash,
        p_stellar_address: stellarAddress,
        p_ledger_number: ledgerNumber.toString(),
        p_transaction_hash: transactionHash,
        p_attested_at: attestedAt,
        p_decision: decision,
      },
    );
    assertNoError(error, "record attestation evidence");

    if (!data || data.length === 0) {
      throw new Error("record attestation evidence returned no result");
    }

    const result = data[0];
    return {
      success: result.success === true,
      reason: result.reason,
    };
  }

  async recordPayoutEvidence(
    recordHash: string,
    stellarAddress: string,
    ledgerNumber: bigint | undefined,
    transactionHash: string,
    pagingToken: string,
    amountUsdc: string,
    paidAt: string,
    decision: string,
  ): Promise<{ success: boolean; reason: string }> {
    const { data, error } = await this.client.rpc(
      "record_payout_evidence",
      {
        p_record_hash: recordHash,
        p_stellar_address: stellarAddress,
        p_ledger_number: ledgerNumber ? ledgerNumber.toString() : null,
        p_transaction_hash: transactionHash,
        p_paging_token: pagingToken,
        p_amount_usdc: Number(amountUsdc),
        p_paid_at: paidAt,
        p_decision: decision,
      },
    );
    assertNoError(error, "record payout evidence");

    if (!data || data.length === 0) {
      throw new Error("record payout evidence returned no result");
    }

    const result = data[0];
    return {
      success: result.success === true,
      reason: result.reason,
    };
  }

  async applyAttestation(event: AttestationEvent): Promise<LedgerAwareApplyResult> {
    // Check for reorg
    const checkpoint = await this.getLedgerCheckpoint("attestations");
    const reorgDetected = isLedgerReorgLikely(
      checkpoint,
      BigInt(event.ledger),
      "", // cursor not available at this layer
    );

    // Apply the base decision
    const { data, error } = await this.client.rpc("apply_chw_attestation", {
      p_record_hash: event.recordHash,
      p_stellar_address: event.stellarAddress,
      p_attested_at: event.attestedAt,
    });
    assertNoError(error, "apply attestation");
    if (data === null) throw new Error("apply attestation returned no decision");

    const decision = data;

    // Record evidence
    let evidenceRecorded = false;
    let evidenceFailureReason: string | undefined;

    try {
      const evidenceResult = await this.recordAttestationEvidence(
        event.recordHash,
        event.stellarAddress,
        BigInt(event.ledger),
        event.transactionHash,
        event.attestedAt,
        decision,
      );
      evidenceRecorded = evidenceResult.success;
      if (!evidenceRecorded) {
        evidenceFailureReason = evidenceResult.reason;
      }
    } catch (err) {
      evidenceFailureReason = err instanceof Error ? err.message : "unknown";
    }

    // Log conflict if reorg detected
    let conflictLogged = false;
    if (reorgDetected && checkpoint) {
      try {
        await this.client.from("conflicting_observations").insert({
          record_hash: event.recordHash,
          conflict_type: "reorg_detected",
          previous_state: {
            ledger: checkpoint.ledgerNumber.toString(),
            txHash: checkpoint.lastTxHash,
          },
          current_state: {
            ledger: event.ledger,
            txHash: event.transactionHash,
          },
        });
        conflictLogged = true;
      } catch {
        // Swallow conflict logging errors; don't block apply
      }
    }

    return {
      decision,
      evidenceRecorded,
      evidenceFailureReason,
      reorgDetected,
      conflictLogged,
    };
  }

  async applyPayout(event: PayoutEvent): Promise<LedgerAwareApplyResult> {
    // Check for reorg
    const checkpoint = await this.getLedgerCheckpoint("payments");
    const reorgDetected = isLedgerReorgLikely(checkpoint, BigInt(event.ledger ?? 0), event.pagingToken);

    // Apply the base decision
    const { data, error } = await this.client.rpc("apply_chw_payout", {
      p_record_hash: event.recordHash,
      p_stellar_address: event.stellarAddress,
      p_amount_usdc: Number(event.amountUsdc),
      p_payout_tx_hash: event.transactionHash,
      p_paid_at: event.paidAt,
      p_paging_token: event.pagingToken,
    });
    assertNoError(error, "apply payout");
    if (data === null) throw new Error("apply payout returned no decision");

    const decision = data;

    // Record evidence
    let evidenceRecorded = false;
    let evidenceFailureReason: string | undefined;

    try {
      const evidenceResult = await this.recordPayoutEvidence(
        event.recordHash,
        event.stellarAddress,
        event.ledger ? BigInt(event.ledger) : undefined,
        event.transactionHash,
        event.pagingToken,
        event.amountUsdc,
        event.paidAt,
        decision,
      );
      evidenceRecorded = evidenceResult.success;
      if (!evidenceRecorded) {
        evidenceFailureReason = evidenceResult.reason;
      }
    } catch (err) {
      evidenceFailureReason = err instanceof Error ? err.message : "unknown";
    }

    // Log conflict if reorg detected
    let conflictLogged = false;
    if (reorgDetected && checkpoint) {
      try {
        await this.client.from("conflicting_observations").insert({
          record_hash: event.recordHash,
          conflict_type: "reorg_detected",
          previous_state: {
            cursor: checkpoint.cursor,
            txHash: checkpoint.lastTxHash,
          },
          current_state: {
            cursor: event.pagingToken,
            txHash: event.transactionHash,
          },
        });
        conflictLogged = true;
      } catch {
        // Swallow conflict logging errors
      }
    }

    return {
      decision,
      evidenceRecorded,
      evidenceFailureReason,
      reorgDetected,
      conflictLogged,
    };
  }

  async getConflictingRecords(): Promise<ConflictingObservation[]> {
    const { data, error } = await this.client
      .from("conflicting_observations")
      .select("*")
      .eq("resolved", false)
      .order("detected_at", { ascending: false });
    assertNoError(error, "get conflicting observations");

    if (!data) {
      return [];
    }

    return data.map((row: any) => ({
      id: row.id,
      recordHash: row.record_hash,
      conflictType: row.conflict_type,
      previousState: row.previous_state,
      currentState: row.current_state,
      detectedAt: new Date(row.detected_at),
      resolved: row.resolved,
      resolutionNotes: row.resolution_notes,
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    }));
  }

  async reconcileConflictingRecord(
    conflictId: string,
    resolutionNotes: string,
  ): Promise<void> {
    const { error } = await this.client.rpc("reconcile_conflicting_record", {
      p_conflict_id: conflictId,
      p_resolution_notes: resolutionNotes,
    });
    assertNoError(error, "reconcile conflicting record");
  }
}
