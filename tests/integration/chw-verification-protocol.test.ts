import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProfileRow } from "@/lib/supabase/types";
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const NETWORK_HASH = "ab".repeat(32);
const RECORD_HASH = "cd".repeat(32);
const NEXT_RECORD_HASH = "ef".repeat(32);
const SUPERSEDED_RECORD_HASH = "12".repeat(32);

function testStellarAddress(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return `G${Array.from(
    crypto.getRandomValues(new Uint8Array(55)),
    (byte) => alphabet[byte & 31],
  ).join("")}`;
}

describe("CHW verification protocol", () => {
  let patient: TestUser;
  let chwOne: TestUser;
  let chwTwo: TestUser;
  let profile: ProfileRow;
  let epochId: string;
  let submissionId: string | undefined;
  let addressOne: string;
  let addressTwo: string;

  beforeAll(async () => {
    patient = await createTestUser();
    chwOne = await createTestUser();
    chwTwo = await createTestUser();
    addressOne = testStellarAddress();
    addressTwo = testStellarAddress();

    const inserted = await patient.client
      .from("profiles")
      .insert({ user_id: patient.id, name: "Protocol Patient" });
    if (inserted.error) throw inserted.error;
    const selected = await patient.client
      .from("profiles")
      .select("*")
      .eq("user_id", patient.id)
      .single();
    if (selected.error) throw selected.error;
    profile = selected.data;

    const consent = await patient.client.rpc("record_consent", {
      p_purpose: "clinical_verification",
      p_purpose_version: 1,
      p_action: "acknowledged",
      p_idempotency_key: crypto.randomUUID(),
    });
    if (consent.error) throw consent.error;

    const identities = await adminClient.from("chw_identities").insert([
      {
        chw_id: chwOne.id,
        stellar_address: addressOne,
        status: "active",
        proof_challenge: "challenge-one",
        proof_signature: "signature-one",
        recovery_nonce: crypto.randomUUID(),
        bound_at: new Date().toISOString(),
      },
      {
        chw_id: chwTwo.id,
        stellar_address: addressTwo,
        status: "active",
        proof_challenge: "challenge-two",
        proof_signature: "signature-two",
        recovery_nonce: crypto.randomUUID(),
        bound_at: new Date().toISOString(),
      },
    ]);
    if (identities.error) throw identities.error;

    const epoch = await adminClient
      .from("attestation_contract_epochs")
      .insert({
        network_passphrase_hash: NETWORK_HASH,
        contract_id: "CVERIFICATION",
        contract_version: "1.0.0",
        schema_version: 1,
        minimum_finality_depth: 2,
      })
      .select("id")
      .single();
    if (epoch.error) throw epoch.error;
    epochId = epoch.data.id;
  });

  afterAll(async () => {
    if (submissionId) {
      await adminClient
        .from("payout_obligations")
        .delete()
        .eq("submission_id", submissionId);
      await adminClient
        .from("verification_trust_events")
        .delete()
        .eq("submission_id", submissionId);
      await adminClient
        .from("verification_submissions")
        .delete()
        .eq("id", submissionId);
    }
    if (epochId) {
      await adminClient
        .from("attestation_contract_epochs")
        .delete()
        .eq("id", epochId);
    }
    if (chwOne) {
      await adminClient.from("chw_identities").delete().eq("chw_id", chwOne.id);
      await deleteTestUser(chwOne.id);
    }
    if (chwTwo) {
      await adminClient.from("chw_identities").delete().eq("chw_id", chwTwo.id);
      await deleteTestUser(chwTwo.id);
    }
    if (patient) await deleteTestUser(patient.id);
  });

  it("gives one CHW a lease when two workers race for one exact revision", async () => {
    const request = await patient.client.rpc("request_revision_verification", {
      p_expected_revision_id: profile.current_revision_id!,
    });
    if (request.error) throw request.error;

    const [one, two] = await Promise.all([
      adminClient.rpc("claim_verification_request", { p_chw_id: chwOne.id }),
      adminClient.rpc("claim_verification_request", { p_chw_id: chwTwo.id }),
    ]);
    if (one.error) throw one.error;
    if (two.error) throw two.error;
    const claims = [...(one.data ?? []), ...(two.data ?? [])];
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      request_id: request.data!.id,
      revision_id: request.data!.revision_id,
      record_hash: request.data!.record_hash,
    });
  });

  it("binds the accepted intent and one payout obligation to the leased address", async () => {
    const claim = await adminClient.rpc("claim_verification_request", {
      p_chw_id: chwOne.id,
    });
    if (claim.error) throw claim.error;
    // The first test already has the request leased. Renew it to retrieve a
    // stable lease and use that exact claimant for the submission.
    const request = await adminClient
      .from("reattestation_requests")
      .select("*")
      .eq("user_id", patient.id)
      .eq("status", "under_review")
      .single();
    if (request.error) throw request.error;
    const activeClaim = request.data;
    const expiration = new Date(Date.now() + 5 * 60_000).toISOString();
    const identity = activeClaim.claimed_by === chwOne.id ? chwOne : chwTwo;
    const address = identity === chwOne ? addressOne : addressTwo;
    const submission = await adminClient.rpc("record_verification_submission", {
      p_request_id: activeClaim.id,
      p_chw_id: identity.id,
      p_lease_token: activeClaim.lease_token!,
      p_contract_epoch_id: epochId,
      p_idempotency_key: crypto.randomUUID(),
      p_intent_hash: RECORD_HASH,
      p_intent_payload: {
        requestId: activeClaim.id,
        revisionId: activeClaim.revision_id,
        recordHash: activeClaim.record_hash,
        schemaVersion: "1",
        networkPassphraseHash: NETWORK_HASH,
        contractId: "CVERIFICATION",
        chwId: identity.id,
        stellarAddress: address,
        expiresAt: expiration,
      },
      p_intent_signature: "wallet-signature",
      p_intent_expires_at: expiration,
    });
    if (submission.error) throw submission.error;
    submissionId = submission.data.id;

    const finalized = await adminClient.rpc("finalize_verification_trust", {
      p_submission_id: submissionId,
      p_decision: "verified",
      p_transaction_hash: "ledger-transaction",
      p_ledger_sequence: 123,
      p_ledger_hash: "ledger-hash",
      p_event_position: 0,
      p_finality_depth: 2,
      p_finalized_at: new Date().toISOString(),
      p_evidence: { source: "test-ledger" },
      p_amount: 1.25,
      p_amount_version: "pilot-v1",
      p_asset_code: "USDC",
      p_asset_issuer: "GISSUER",
      p_sponsor_pool_address: "GPOOL",
    });
    if (finalized.error) throw finalized.error;

    // A replay of final ledger evidence appends audit evidence but cannot
    // create a second obligation.
    const replay = await adminClient.rpc("finalize_verification_trust", {
      p_submission_id: submissionId,
      p_decision: "verified",
      p_transaction_hash: "ledger-transaction",
      p_ledger_sequence: 123,
      p_ledger_hash: "ledger-hash",
      p_event_position: 0,
      p_finality_depth: 2,
      p_finalized_at: new Date().toISOString(),
      p_evidence: { source: "test-ledger-replay" },
      p_amount: 1.25,
      p_amount_version: "pilot-v1",
      p_asset_code: "USDC",
      p_asset_issuer: "GISSUER",
      p_sponsor_pool_address: "GPOOL",
    });
    if (replay.error) throw replay.error;

    const obligations = await adminClient
      .from("payout_obligations")
      .select("recipient_stellar_address")
      .eq("submission_id", submissionId);
    if (obligations.error) throw obligations.error;
    expect(obligations.data).toEqual([{ recipient_stellar_address: address }]);
  });

  it("supersedes an unsubmitted claimed request after the patient edits", async () => {
    const current = await patient.client
      .from("profiles")
      .select("current_revision_id, disclosure_policy")
      .eq("user_id", patient.id)
      .single();
    if (current.error) throw current.error;

    const firstEdit = await patient.client.rpc("save_record_revision", {
      p_expected_revision_id: current.data.current_revision_id,
      p_emergency_data: {
        name: "Protocol Patient, edited",
        date_of_birth: null,
        photo_url: null,
        language: null,
        blood_group: "unknown",
        genotype: "unknown",
        allergies: [],
        medications: [],
        chronic_conditions: [],
        emergency_contacts: [],
      },
      p_provenance: {},
      p_disclosure_policy: current.data.disclosure_policy,
      p_commitment: NEXT_RECORD_HASH,
    });
    if (firstEdit.error) throw firstEdit.error;
    const requested = await patient.client.rpc(
      "request_revision_verification",
      {
        p_expected_revision_id: firstEdit.data.id,
      },
    );
    if (requested.error) throw requested.error;
    const claim = await adminClient.rpc("claim_verification_request", {
      p_chw_id: chwOne.id,
    });
    if (claim.error) throw claim.error;
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const rejectedIntent = await adminClient.rpc(
      "record_verification_submission",
      {
        p_request_id: requested.data.id,
        p_chw_id: chwOne.id,
        p_lease_token: claim.data![0].lease_token,
        p_contract_epoch_id: epochId,
        p_idempotency_key: crypto.randomUUID(),
        p_intent_hash: RECORD_HASH,
        p_intent_payload: {
          requestId: requested.data.id,
          revisionId: requested.data.revision_id,
          recordHash: requested.data.record_hash,
          schemaVersion: "1",
          networkPassphraseHash: NETWORK_HASH,
          contractId: "CVERIFICATION",
          chwId: chwOne.id,
          stellarAddress: addressOne,
          expiresAt,
          medicalNarrative: "must never persist",
        },
        p_intent_signature: "wallet-signature",
        p_intent_expires_at: expiresAt,
      },
    );
    expect(rejectedIntent.error?.message).toBe(
      "INTENT_CONTAINS_UNSUPPORTED_FIELDS",
    );

    const replacement = await patient.client.rpc("save_record_revision", {
      p_expected_revision_id: requested.data.revision_id!,
      p_emergency_data: {
        name: "Protocol Patient, replacement",
        date_of_birth: null,
        photo_url: null,
        language: null,
        blood_group: "unknown",
        genotype: "unknown",
        allergies: [],
        medications: [],
        chronic_conditions: [],
        emergency_contacts: [],
      },
      p_provenance: {},
      p_disclosure_policy: current.data.disclosure_policy,
      p_commitment: SUPERSEDED_RECORD_HASH,
    });
    if (replacement.error) throw replacement.error;
    const oldRequest = await adminClient
      .from("reattestation_requests")
      .select("status, lease_token, lease_expires_at")
      .eq("id", requested.data.id)
      .single();
    if (oldRequest.error) throw oldRequest.error;
    expect(oldRequest.data).toMatchObject({
      status: "superseded",
      lease_token: null,
      lease_expires_at: null,
    });
  });
});
