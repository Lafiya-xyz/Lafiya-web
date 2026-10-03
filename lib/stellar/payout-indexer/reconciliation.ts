/**
 * Reconciliation logic for detecting and resolving inconsistent records
 * across attestation and payout state. Runs independently and identifies
 * records that silently diverged (verified but not paid, paid but not verified, etc.).
 *
 * Designed to be called periodically (or on-demand by operators) to detect
 * inconsistencies that the main indexer loop may have missed due to provider
 * lag or conflicting observations.
 *
 * Also exposes double-entry ledger reconciliation helpers (issue #562): the
 * journal is the source of truth for CHW incentives, so reconciliation is a
 * query over `ledger_entries` rather than a script over independent rows.
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
 * Result of reconciling the double-entry journal against the legacy
 * obligation/settlement tables. `balanced` is true when every journal sums to
 * zero and the derived balances match the legacy rows.
 */
export interface LedgerReconciliationResult {
  balanced: boolean;
  unbalancedJournals: Array<{ journalId: string; netStroops: string }>;
  chwPayableStroops: string;
  chwSettledStroops: string;
  poolLiabilityStroops: string;
  legacyObligationStroops: string;
  legacySettlementStroops: string;
  discrepancies: string[];
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
   * Reconcile the double-entry journal (issue #562).
   *
   * Every journal must balance to zero (enforced by a deferred constraint
   * trigger in the database); this pass surfaces any journal that does not,
   * and compares the derived CHW payable / settled balances against the legacy
   * `payout_obligations` and `payout_settlements` rows so the backfill can be
   * verified. Read-only: never mutates ledger state.
   */
  async reconcileLedger(): Promise<LedgerReconciliationResult> {
    try {
      logInfo("Starting double-entry ledger reconciliation pass");

      const { data: entries, error: entriesError } = await this.client
        .from("ledger_entries")
        .select("journal_id, account_id, amount_stroops, direction");

      if (entriesError) {
        throw new Error(`fetch ledger_entries: ${entriesError.message}`);
      }

      const { data: accounts, error: accountsError } = await this.client
        .from("ledger_accounts")
        .select("id, code");

      if (accountsError) {
        throw new Error(`fetch ledger_accounts: ${accountsError.message}`);
      }

      const accountCodeById = new Map(
        (accounts || []).map((acct: any) => [acct.id, acct.code as string]),
      );

      // Sum signed entries per journal; a balanced journal nets to zero.
      const journalNets = new Map<string, bigint>();
      const balanceByCode = new Map<string, bigint>();

      for (const entry of entries || []) {
        const amount = BigInt(entry.amount_stroops);
        const signed = entry.direction === "debit" ? amount : -amount;

        const journalId = entry.journal_id as string;
        journalNets.set(journalId, (journalNets.get(journalId) ?? 0n) + signed);

        const code = accountCodeById.get(entry.account_id) ?? "unknown";
        balanceByCode.set(code, (balanceByCode.get(code) ?? 0n) + signed);
      }

      const unbalancedJournals = Array.from(journalNets.entries())
        .filter(([, net]) => net !== 0n)
        .map(([journalId, net]) => ({ journalId, netStroops: net.toString() }));

      const chwPayableStroops = (balanceByCode.get("chw_payable") ?? 0n).toString();
      const chwSettledStroops = (balanceByCode.get("chw_settled") ?? 0n).toString();
      const poolLiabilityStroops = (balanceByCode.get("pool") ?? 0n).toString();

      // Compare against legacy rows so the backfill can be verified.
      const { data: obligations, error: obligationsError } = await this.client
        .from("payout_obligations")
        .select("amount_stroops");

      if (obligationsError) {
        throw new Error(`fetch payout_obligations: ${obligationsError.message}`);
      }

      const { data: settlements, error: settlementsError } = await this.client
        .from("payout_settlements")
        .select("amount_stroops");

      if (settlementsError) {
        throw new Error(`fetch payout_settlements: ${settlementsError.message}`);
      }

      const legacyObligationStroops = (obligations || [])
        .reduce((sum: bigint, row: any) => sum + BigInt(row.amount_stroops), 0n)
        .toString();
      const legacySettlementStroops = (settlements || [])
        .reduce((sum: bigint, row: any) => sum + BigInt(row.amount_stroops), 0n)
        .toString();

      const discrepancies: string[] = [];
      if (unbalancedJournals.length > 0) {
        discrepancies.push(`${unbalancedJournals.length} journal(s) do not balance to zero`);
      }
      if (chwPayableStroops !== legacyObligationStroops) {
        discrepancies.push(
          `chw_payable (${chwPayableStroops}) != payout_obligations (${legacyObligationStroops})`,
        );
      }
      if (chwSettledStroops !== legacySettlementStroops) {
        discrepancies.push(
          `chw_settled (${chwSettledStroops}) != payout_settlements (${legacySettlementStroops})`,
        );
      }

      const result: LedgerReconciliationResult = {
        balanced: discrepancies.length === 0,
        unbalancedJournals,
        chwPayableStroops,
        chwSettledStroops,
        poolLiabilityStroops,
        legacyObligationStroops,
        legacySettlementStroops,
        discrepancies,
      };

      if (result.balanced) {
        logInfo("Double-entry ledger reconciliation pass complete", {
          chwPayableStroops,
          chwSettledStroops,
          poolLiabilityStroops,
        });
      } else {
        logWarn("Double-entry ledger reconciliation found discrepancies", {
          discrepancies,
        });
      }

      return result;
    } catch (error) {
      logError("Double-entry ledger reconciliation pass failed", error);
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
        .order("evidence