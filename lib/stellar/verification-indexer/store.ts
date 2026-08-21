import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

import type {
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
