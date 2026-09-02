/**
 * Reconciliation logic for detecting and resolving inconsistent records
 * across attestation and payout state. Runs independently and identifies
 * records that silently diverged (verified but not paid, paid but not verified, etc.).
 *
 * Designed to be called periodically (or on-demand by operators) to detect
 * inconsistencies that the main indexer loop may have missed due to provider
 * lag or conflicting observations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";
import { logError, logInfo, logWarn } from "@/lib/logging/logger";

export interface ReconciliationRecord {
  recordHash: string;
  // Attestation state
  attestationExists: boolean;
  attestationLedger?: bigint;
  attestationTxHash?: string;
  attestationTimestamp?: string;
  revoked?: boolean;
  expiry?: number;
  // Payout state
  payoutStatus?: "pending" | "paid" | "awaiting_attestation" | "address_mismatch";
  payoutLedger?: bigint;
  payoutTxHash?: string;
  payoutAmount?: string;
  payoutTimestamp?: string;
  // Conflict
  isInconsistent: boolean;
  inconsistencyType?: string;
}

export interface ReconciliationBatch {
  totalRecords: number;
  inconsistentRecords: ReconciliationRecord[];
  paidButNotVerified: ReconciliationRecord[];
  verifiedButNotPaid: ReconciliationRecord[];
  revokedButPaid: ReconciliationRecord[];
  expiredButPaid: ReconciliationRecord[];
  addressMismatchRecords: ReconciliationRecord[];
}

/**
 * Audit-safe reconciliation: cross-reference attestation and payout state
 * to identify silently diverged records. Does not modify state, only logs conflicts.
 */
export class ReconciliationEngine {
  constructor(private readonly client: SupabaseClient<Database> = createAdminClient()) {}

  /**
   * Reconcile all records: compare attestation evidence against payout status.
   * Returns a summary of detected inconsistencies without modifying state.
   */
  async reconcileAll(): Promise<ReconciliationBatch> {
    try {
      logInfo("Starting full reconciliation pass");

      // Fetch all attestation evidence
      const { data: attestationData, error: attestationError } = await this.client
        .from("attestation_evidence")
        .select("*");

      if (attestationError) {
        throw new Error(`fetch attestation evidence: ${attestationError.message}`);
      }

      // Fetch all payout evidence
      const { data: payoutData, error: payoutError } = await this.client
        .from("payout_evidence")
        .select("*");

      if (payoutError) {
        throw new Error(`fetch payout evidence: ${payoutError.message}`);
      }

      // Fetch all payout records
      const { data: payoutsData, error: payoutsError } = await this.client
        .from("chw_payouts")
        .select("*");

      if (payoutsError) {
        throw new Error(`fetch chw_payouts: ${payoutsError.message}`);
      }

      // Build maps for quick lookup
      const attestationsByHash = new Map(
        (attestationData || []).map((att: any) => [att.record_hash, att]),
      );
      const payoutsByHash = new Map(
        (payoutsData || []).map((payout: any) => [payout.record_hash, payout]),
      );
      const payoutEvidenceByHash = new Map(
        (payoutData || []).map((pe: any) => [pe.record_hash, pe]),
      );

      // Collect all unique record hashes
      const allHashes = new Set([
        ...attestationsByHash.keys(),
        ...payoutsByHash.keys(),
      ]);

      const inconsistentRecords: ReconciliationRecord[] = [];
      const paidButNotVerified: ReconciliationRecord[] = [];
      const verifiedButNotPaid: ReconciliationRecord[] = [];
      const revokedButPaid: ReconciliationRecord[] = [];
      const expiredButPaid: ReconciliationRecord[] = [];
      const addressMismatchRecords: ReconciliationRecord[] = [];

      // Analyze each record
      for (const recordHash of allHashes) {
        const attestation = attestationsByHash.get(recordHash);
        const payout = payoutsByHash.get(recordHash);
        const payoutEvidence = payoutEvidenceByHash.get(recordHash);

        const record: ReconciliationRecord = {
          recordHash,
          attestationExists: !!attestation,
          isInconsistent: false,
        };

        // Populate attestation state
        if (attestation) {
          record.attestationLedger = BigInt(attestation.ledger_number);
          record.attestationTxHash = attestation.transaction_hash;
          record.attestationTimestamp = attestation.attested_at;
          record.revoked = attestation.revoked;
          record.expiry = attestation.expiry;
        }

        // Populate payout state
        if (payout) {
          record.payoutStatus = payout.status;
          record.payoutTxHash = payout.payout_tx_hash;
          record.payoutAmount = payout.amount_usdc;
          record.payoutTimestamp = payout.paid_at;
        }

        if (payoutEvidence) {
          record.payoutLedger = payoutEvidence.ledger_number ? BigInt(payoutEvidence.ledger_number) : undefined;
        }

        // Detect inconsistencies
        const issues: string[] = [];

        // Check: paid but no attestation
        if (payout?.status === "paid" && !attestation) {
          issues.push("paid_without_attestation");
          paidButNotVerified.push(record);
        }

        // Check: verified but not paid
        if (attestation && payout?.status !== "paid") {
          issues.push("verified_not_paid");
          verifiedButNotPaid.push(record);
        }

        // Check: revoked but still marked paid
        if (attestation?.revoked && payout?.status === "paid") {
          issues.push("revoked_but_paid");
          revokedButPaid.push(record);
        }

        // Check: expired but still marked paid
        const now = Math.floor(Date.now() / 1000);
        if (attestation?.expiry && attestation.expiry < now && payout?.status === "paid") {
          issues.push("expired_but_paid");
          expiredButPaid.push(record);
        }

        // Check: address mismatch in observations
        if (payout?.status === "address_mismatch") {
          issues.push("address_mismatch");
          addressMismatchRecords.push(record);
        }

        if (issues.length > 0) {
          record.isInconsistent = true;
          record.inconsistencyType = issues.join(", ");
          inconsistentRecords.push(record);
        }
      }

      const batch: ReconciliationBatch = {
        totalRecords: allHashes.size,
        inconsistentRecords,
        paidButNotVerified,
        verifiedButNotPaid,
        revokedButPaid,
        expiredButPaid,
        addressMismatchRecords,
      };

      logInfo("Reconciliation pass complete", {
        totalRecords: batch.totalRecords,
        inconsistentCount: batch.inconsistentRecords.length,
        paidNotVerified: batch.paidButNotVerified.length,
        verifiedNotPaid: batch.verifiedButNotPaid.length,
        revokedButPaid: batch.revokedButPaid.length,
        expiredButPaid: batch.expiredButPaid.length,
        addressMismatch: batch.addressMismatchRecords.length,
      });

      return batch;
    } catch (error) {
      logError("Reconciliation pass failed", error);
      throw error;
    }
  }

  /**
   * Deep reconcile a single record: fetch all evidence, verify consistency,
   * and suggest resolution steps without modifying state.
   */
  async reconcileRecord(
    recordHash: string,
  ): Promise<{
    record: ReconciliationRecord;
    evidenceChain: Array<{
      type: string;
      timestamp: string;
      ledger?: bigint;
      txHash: string;
      decision: string;
    }>;
    recommendedActions: string[];
  }> {
    try {
      // Fetch all evidence for this record
      const { data: attestationEv, error: attestationEvError } = await this.client
        .from("attestation_evidence")
        .select("*")
        .eq("record_hash", recordHash)
        .order("evidence_recorded_at", { ascending: true });

      if (attestationEvError) {
        throw new Error(`fetch attestation evidence: ${attestationEvError.message}`);
      }

      const { data: payoutEv, error: payoutEvError } = await this.client
        .from("payout_evidence")
        .select("*")
        .eq("record_hash", recordHash)
        .order("evidence_recorded_at", { ascending: true });

      if (payoutEvError) {
        throw new Error(`fetch payout evidence: ${payoutEvError.message}`);
      }

      const { data: payout, error: payoutError } = await this.client
        .from("chw_payouts")
        .select("*")
        .eq("record_hash", recordHash)
        .maybeSingle();

      if (payoutError) {
        throw new Error(`fetch payout: ${payoutError.message}`);
      }

      const { data: conflicts, error: conflictError } = await this.client
        .from("conflicting_observations")
        .select("*")
        .eq("record_hash", recordHash)
        .order("detected_at", { ascending: true });

      if (conflictError) {
        throw new Error(`fetch conflicts: ${conflictError.message}`);
      }

      // Build evidence chain (timeline of all decisions)
      const evidenceChain = [
        ...(attestationEv || []).map((att: any) => ({
          type: "attestation",
          timestamp: att.evidence_recorded_at,
          ledger: BigInt(att.ledger_number),
          txHash: att.transaction_hash,
          decision: att.decision,
        })),
        ...(payoutEv || []).map((pay: any) => ({
          type: "payout",
          timestamp: pay.evidence_recorded_at,
          ledger: pay.ledger_number ? BigInt(pay.ledger_number) : undefined,
          txHash: pay.transaction_hash,
          decision: pay.decision,
        })),
      ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      // Build the reconciliation record
      const latestAttestation = (attestationEv || [])[(attestationEv?.length || 0) - 1];
      const record: ReconciliationRecord = {
        recordHash,
        attestationExists: !!latestAttestation,
        isInconsistent: false,
      };

      if (latestAttestation) {
        record.attestationLedger = BigInt(latestAttestation.ledger_number);
        record.attestationTxHash = latestAttestation.transaction_hash;
        record.attestationTimestamp = latestAttestation.attested_at;
      }

      if (payout) {
        record.payoutStatus = payout.status;
        record.payoutTxHash = payout.payout_tx_hash;
        record.payoutAmount = payout.amount_usdc;
        record.payoutTimestamp = payout.paid_at;
      }

      // Generate recommended actions based on evidence and state
      const recommendedActions: string[] = [];

      if (!latestAttestation && payout?.status === "paid") {
        record.isInconsistent = true;
        recommendedActions.push(
          "WARNING: Record is marked paid but has no attestation evidence. Review Soroban RPC logs.",
        );
        recommendedActions.push("ACTION: Query contract directly to verify attestation status.");
      }

      if (latestAttestation && payout?.status !== "paid") {
        recommendedActions.push(
          "INFO: Attestation recorded but payout not yet confirmed. Verify payout status in Horizon.",
        );
        recommendedActions.push("ACTION: Check CHW address and payout pool configuration.");
      }

      if (latestAttestation?.revoked && payout?.status === "paid") {
        record.isInconsistent = true;
        recommendedActions.push(
          "CRITICAL: Attestation is revoked but payout marked paid. Manual review required.",
        );
        recommendedActions.push("ACTION: Consult with CHW and operations team for remediation.");
      }

      if ((conflicts || []).length > 0) {
        record.isInconsistent = true;
        const unresolved = conflicts.filter((c: any) => !c.resolved);
        recommendedActions.push(
          `ALERT: ${unresolved.length} unresolved conflict observations detected.`,
        );
        recommendedActions.push("ACTION: Review conflicting_observations table for details.");
      }

      return {
        record,
        evidenceChain,
        recommendedActions,
      };
    } catch (error) {
      logError("Record reconciliation failed", error, { recordHash });
      throw error;
    }
  }

  /**
   * Log reconciliation findings as conflicts for operator review.
   * Called after reconcileAll() to formally record detected inconsistencies.
   */
  async logReconciliationConflicts(batch: ReconciliationBatch): Promise<void> {
    try {
      const conflicts = [];

      for (const record of batch.paidButNotVerified) {
        conflicts.push({
          record_hash: record.recordHash,
          conflict_type: "paid_without_attestation",
          previous_state: {
            payoutStatus: record.payoutStatus,
            payoutTxHash: record.payoutTxHash,
          },
          current_state: {
            attestationExists: record.attestationExists,
          },
        });
      }

      for (const record of batch.verifiedButNotPaid) {
        conflicts.push({
          record_hash: record.recordHash,
          conflict_type: "verified_not_paid",
          previous_state: {
            attestationTxHash: record.attestationTxHash,
          },
          current_state: {
            payoutStatus: record.payoutStatus,
          },
        });
      }

      for (const record of batch.revokedButPaid) {
        conflicts.push({
          record_hash: record.recordHash,
          conflict_type: "revoked_attestation",
          previous_state: {
            revoked: true,
            attestationTxHash: record.attestationTxHash,
          },
          current_state: {
            payoutStatus: record.payoutStatus,
            payoutTxHash: record.payoutTxHash,
          },
        });
      }

      for (const record of batch.expiredButPaid) {
        conflicts.push({
          record_hash: record.recordHash,
          conflict_type: "revoked_attestation", // treat expiry like revocation
          previous_state: {
            expiry: record.expiry,
            attestationTxHash: record.attestationTxHash,
          },
          current_state: {
            payoutStatus: record.payoutStatus,
            payoutTxHash: record.payoutTxHash,
          },
        });
      }

      for (const record of batch.addressMismatchRecords) {
        conflicts.push({
          record_hash: record.recordHash,
          conflict_type: "address_mismatch",
          previous_state: {
            payoutStatus: record.payoutStatus,
          },
          current_state: null,
        });
      }

      if (conflicts.length === 0) {
        logInfo("No conflicts to log from reconciliation");
        return;
      }

      // Batch insert conflicts, skipping duplicates
      const { error } = await this.client.from("conflicting_observations").insert(conflicts);

      if (error) {
        // Ignore unique constraint violations (conflict already logged)
        if (error.code !== "23505") {
          throw error;
        }
        logWarn("Some conflicts were already logged", { conflictCount: conflicts.length });
      } else {
        logInfo("Reconciliation conflicts logged", { conflictCount: conflicts.length });
      }
    } catch (error) {
      logError("Failed to log reconciliation conflicts", error);
      throw error;
    }
  }
}
