import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import type {
  ContractAdminEvent,
  ContractGovernanceStore,
  ContractTrustStatus,
  FinalizedAttestationEvent,
  VerificationEvidenceStore,
} from "./types";

function assertNoError(
  error: { message: string } | null,
  operation: string,
): void {
  if (error) throw new Error(`${operation}: ${error.message}`);
}

/** Database adapter used by the protocol worker, never by a browser client. */
export class SupabaseVerificationEvidenceStore implements VerificationEvidenceStore {
  constructor(
    private readonly client: SupabaseClient<Database> = createAdminClient(),
  ) {}

  async getCursor(): Promise<string | null> {
    const { data, error } = await this.client
      .from("protocol_indexer_checkpoints")
      .select("cursor")
      .eq("stream", "attestations")
      .maybeSingle();
    assertNoError(error, "read protocol checkpoint");
    return data?.cursor ?? null;
  }

  async applyFinalized(event: FinalizedAttestationEvent): Promise<void> {
    const { error } = await this.client.rpc(
      "apply_finalized_attestation_evidence",
      {
        p_event_id: event.eventId,
        p_intent_id: event.intentId,
        p_record_commitment: event.recordCommitment,
        p_attester_address: event.attesterAddress,
        p_transaction_hash: event.transactionHash,
        p_ledger_sequence: event.ledgerSequence,
        p_ledger_hash: event.ledgerHash,
        p_event_index: event.eventIndex,
        p_observed_at: event.observedAt,
        p_finalized_at: event.finalizedAt,
        p_network_passphrase_hash: event.networkPassphraseHash,
        p_contract_id: event.contractId,
        p_contract_version: event.contractVersion,
        p_schema_version: event.schemaVersion,
        p_idempotency_key: event.idempotencyKey,
      },
    );
    assertNoError(error, "apply finalized attestation evidence");
  }

  async quarantine(eventId: string, reasonCode: string): Promise<void> {
    const { error } = await this.client.rpc("quarantine_protocol_event", {
      p_stream: "attestations",
      p_event_id: eventId,
      p_reason_code: reasonCode,
    });
    assertNoError(error, "quarantine protocol event");
  }

  async saveCursor(cursor: string): Promise<void> {
    const { error } = await this.client
      .from("protocol_indexer_checkpoints")
      .upsert(
        {
          stream: "attestations",
          cursor,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stream" },
      );
    assertNoError(error, "save protocol checkpoint");
  }
}

/** Database adapter for the attestation-contract governance monitor. */
export class SupabaseContractGovernanceStore implements ContractGovernanceStore {
  constructor(
    private readonly client: SupabaseClient<Database> = createAdminClient(),
  ) {}

  async getCursor(): Promise<string | null> {
    const { data, error } = await this.client
      .from("protocol_indexer_checkpoints")
      .select("cursor")
      .eq("stream", "contract_admin")
      .maybeSingle();
    assertNoError(error, "read contract admin checkpoint");
    return data?.cursor ?? null;
  }

  async getTrustStatus(): Promise<ContractTrustStatus | null> {
    const { data, error } = await this.client
      .from("attestation_contract_trust_state")
      .select("state, wasm_hash, reason_code")
      .maybeSingle();
    assertNoError(error, "read contract trust state");
    return data
      ? {
          state: data.state,
          wasmHash: data.wasm_hash,
          reasonCode: data.reason_code,
        }
      : null;
  }

  async recordAdminEvent(event: ContractAdminEvent): Promise<void> {
    const { error } = await this.client
      .from("attestation_contract_admin_events")
      .upsert(
        {
          event_id: event.eventId,
          kind: event.kind,
          contract_id: event.contractId,
          ledger_sequence: event.ledgerSequence,
          transaction_hash: event.transactionHash,
          wasm_hash: event.wasmHash ?? null,
          subject: event.subject ?? null,
          action: event.action ?? null,
          observed_at: event.observedAt,
        },
        { onConflict: "event_id", ignoreDuplicates: true },
      );
    assertNoError(error, "record contract admin event");
  }

  async setTrustStatus(status: ContractTrustStatus): Promise<void> {
    const { error } = await this.client
      .from("attestation_contract_trust_state")
      .upsert(
        {
          singleton: true,
          state: status.state,
          wasm_hash: status.wasmHash,
          reason_code: status.reasonCode,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "singleton" },
      );
    assertNoError(error, "save contract trust state");
  }

  async saveCursor(cursor: string): Promise<void> {
    const { error } = await this.client
      .from("protocol_indexer_checkpoints")
      .upsert(
        {
          stream: "contract_admin",
          cursor,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stream" },
      );
    assertNoError(error, "save contract admin checkpoint");
  }
}
