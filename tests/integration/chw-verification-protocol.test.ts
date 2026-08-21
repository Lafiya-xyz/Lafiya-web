import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const ADDRESS = `G${"A".repeat(55)}`;
const SPONSOR = `G${"B".repeat(55)}`;
const CONTRACT = `C${"C".repeat(55)}`;

describe("CHW verification protocol", () => {
  let patient: TestUser;
  let chwOne: TestUser;
  let chwTwo: TestUser;
  let requestId: string;
  let epochId: string;
  let leaseToken: string;
  let intentId: string;

  beforeAll(async () => {
    patient = await createTestUser();
    chwOne = await createTestUser();
    chwTwo = await createTestUser();
    const profileInsert = await patient.client
      .from("profiles")
      .insert({ user_id: patient.id, name: "Protocol patient" });
    if (profileInsert.error) throw profileInsert.error;
    const profile = await adminClient
      .from("profiles")
      .select("current_revision_id")
      .eq("user_id", patient.id)
      .single();
    if (profile.error || !profile.data.current_revision_id) throw profile.error;
    const revision = await adminClient
      .from("record_revisions")
      .select("commitment")
      .eq("id", profile.data.current_revision_id)
      .single();
    if (revision.error) throw revision.error;
    const request = await adminClient
      .from("reattestation_requests")
      .insert({
        user_id: patient.id,
        revision_id: profile.data.current_revision_id,
        record_hash: revision.data.commitment,
      })
      .select("id")
      .single();
    if (request.error) throw request.error;
    requestId = request.data.id;

    for (const chw of [chwOne, chwTwo]) {
      const identity = await adminClient.from("chw_identities").insert({
        chw_id: chw.id,
        status: "active",
        approved_at: new Date().toISOString(),
      });
      if (identity.error) throw identity.error;
      const binding = await adminClient.from("chw_address_bindings").insert({
        chw_id: chw.id,
        stellar_address: chw.id === chwOne.id ? ADDRESS : `G${"D".repeat(55)}`,
        ownership_proof_digest: crypto
          .randomUUID()
          .replaceAll("-", "")
          .padEnd(64, "0"),
        allowlist_synced_at: new Date().toISOString(),
      });
      if (binding.error) throw binding.error;
    }
    const epoch = await adminClient
      .from("protocol_epochs")
      .insert({
        schema_version: 1,
        network_passphrase_hash: "1".repeat(64),
        contract_id: CONTRACT,
        contract_version: "1.0.0",
        event_version: 1,
        finality_depth: 2,
        payout_amount_usdc: 2.5,
        asset_identifier: "USDC:test-issuer",
        sponsor_pool: SPONSOR,
      })
      .select("id")
      .single();
    if (epoch.error) throw epoch.error;
    epochId = epoch.data.id;
  });

  afterAll(async () => {
    // A failed local Supabase bootstrap leaves the test users uninitialized.
    // Avoid obscuring that infrastructure error with cleanup failures.
    if (!patient || !chwOne || !chwTwo) return;

    if (intentId) {
      await adminClient
        .from("payout_obligations")
        .delete()
        .eq("intent_id", intentId);
      await adminClient
        .from("trust_decisions")
        .delete()
        .eq(
          "revision_id",
          (
            await adminClient
              .from("verification_intents")
              .select("revision_id")
              .eq("id", intentId)
              .single()
          ).data?.revision_id ?? "",
        );
      await adminClient
        .from("attestation_evidence")
        .delete()
        .eq("intent_id", intentId);
      await adminClient
        .from("verification_intents")
        .delete()
        .eq("id", intentId);
    }
    if (requestId)
      await adminClient
        .from("reattestation_requests")
        .delete()
        .eq("id", requestId);
    if (epochId)
      await adminClient.from("protocol_epochs").delete().eq("id", epochId);
    for (const chw of [chwOne, chwTwo]) {
      await adminClient
        .from("chw_address_bindings")
        .delete()
        .eq("chw_id", chw.id);
      await adminClient.from("chw_identities").delete().eq("chw_id", chw.id);
    }
    await Promise.all(
      [patient, chwOne, chwTwo].map((user) => deleteTestUser(user.id)),
    );
  });

  it("atomically gives one authorized CHW the exact current revision", async () => {
    const claims = await Promise.all(
      [chwOne, chwTwo].map((chw) =>
        chw.client.rpc("claim_verification_request", {
          p_request_id: requestId,
        }),
      ),
    );
    const accepted = claims.filter((claim) => !claim.error);
    expect(accepted).toHaveLength(1);
    expect(claims.filter((claim) => claim.error)).toHaveLength(1);
    const claim = accepted[0].data?.[0];
    expect(claim).toBeDefined();
    leaseToken = claim!.lease_token;
    expect(claim!.review_data).not.toHaveProperty("date_of_birth");
    const hidden = await chwTwo.client
      .from("verification_intents")
      .select("id");
    expect(hidden.error).not.toBeNull();
  });

  it("rejects a non-owner and binds one intent to its lease and epoch", async () => {
    const nonOwner = await chwTwo.client.rpc("create_verification_intent", {
      p_request_id: requestId,
      p_lease_token: leaseToken,
      p_epoch_id: epochId,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(nonOwner.error?.message).toContain("LEASE_NOT_OWNER");

    const intent = await chwOne.client.rpc("create_verification_intent", {
      p_request_id: requestId,
      p_lease_token: leaseToken,
      p_epoch_id: epochId,
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(intent.error).toBeNull();
    intentId = intent.data!.id;
    const submitted = await chwOne.client.rpc(
      "mark_verification_intent_submitted",
      {
        p_intent_id: intentId,
        p_transaction_hash: "submission-tx-1",
      },
    );
    expect(submitted.data?.submitted_transaction_hash).toBe("submission-tx-1");
  });

  it("finalizes exactly one recipient-bound obligation and safely quarantines a fork", async () => {
    const finalizationArgs = {
      p_event_id: "attestation-event-1",
      p_intent_id: intentId,
      p_record_commitment: (
        await adminClient
          .from("verification_intents")
          .select("record_commitment")
          .eq("id", intentId)
          .single()
      ).data!.record_commitment,
      p_attester_address: ADDRESS,
      p_transaction_hash: "submission-tx-1",
      p_ledger_sequence: 42,
      p_ledger_hash: "ledger-hash-42",
      p_event_index: 0,
      p_observed_at: "2026-08-21T00:00:00.000Z",
      p_finalized_at: "2026-08-21T00:01:00.000Z",
      p_network_passphrase_hash: "1".repeat(64),
      p_contract_id: CONTRACT,
      p_contract_version: "1.0.0",
      p_schema_version: 1,
      p_idempotency_key: (
        await adminClient
          .from("verification_intents")
          .select("idempotency_key")
          .eq("id", intentId)
          .single()
      ).data!.idempotency_key,
    };
    const wrongNetwork = await adminClient.rpc(
      "apply_finalized_attestation_evidence",
      { ...finalizationArgs, p_network_passphrase_hash: "2".repeat(64) },
    );
    expect(wrongNetwork.error?.message).toContain("WRONG_NETWORK");
    const wrongAddress = await adminClient.rpc(
      "apply_finalized_attestation_evidence",
      { ...finalizationArgs, p_attester_address: `G${"Z".repeat(55)}` },
    );
    expect(wrongAddress.error?.message).toContain("WRONG_ADDRESS");
    await expect(
      adminClient.rpc("apply_finalized_attestation_evidence", {
        ...finalizationArgs,
        p_finalized_at: null,
      }),
    ).resolves.toMatchObject({ error: null });
    expect(
      (
        await adminClient
          .from("trust_decisions")
          .select("state")
          .eq(
            "revision_id",
            (
              await adminClient
                .from("verification_intents")
                .select("revision_id")
                .eq("id", intentId)
                .single()
            ).data!.revision_id,
          )
          .single()
      ).data?.state,
    ).toBe("confirming");
    await expect(
      adminClient.rpc("apply_finalized_attestation_evidence", finalizationArgs),
    ).resolves.toMatchObject({ error: null });
    await expect(
      adminClient.rpc("apply_finalized_attestation_evidence", finalizationArgs),
    ).resolves.toMatchObject({ error: null });
    const obligations = await adminClient
      .from("payout_obligations")
      .select("recipient_address,status")
      .eq("intent_id", intentId);
    expect(obligations.data).toEqual([
      { recipient_address: ADDRESS, status: "pending" },
    ]);
    await adminClient.rpc("reconcile_attestation_reorg", {
      p_event_id: "attestation-event-1",
      p_reason_code: "LEDGER_HASH_DIVERGENCE",
    });
    const trust = await adminClient
      .from("trust_decisions")
      .select("state")
      .eq(
        "revision_id",
        (
          await adminClient
            .from("verification_intents")
            .select("revision_id")
            .eq("id", intentId)
            .single()
        ).data!.revision_id,
      )
      .single();
    expect(trust.data?.state).toBe("conflicted");
    expect(
      (
        await adminClient
          .from("payout_obligations")
          .select("status")
          .eq("intent_id", intentId)
          .single()
      ).data?.status,
    ).toBe("quarantined");
  });

  it("fails closed when a CHW is suspended after enrollment", async () => {
    const revision = await adminClient
      .from("verification_intents")
      .select("revision_id,record_commitment")
      .eq("id", intentId)
      .single();
    const request = await adminClient
      .from("reattestation_requests")
      .insert({
        user_id: patient.id,
        revision_id: revision.data!.revision_id,
        record_hash: revision.data!.record_commitment,
      })
      .select("id")
      .single();
    if (request.error) throw request.error;
    const suspension = await adminClient
      .from("chw_identities")
      .update({ status: "suspended", suspended_at: new Date().toISOString() })
      .eq("chw_id", chwTwo.id);
    if (suspension.error) throw suspension.error;
    const claim = await chwTwo.client.rpc("claim_verification_request", {
      p_request_id: request.data.id,
    });
    expect(claim.error?.message).toContain("CHW_SUSPENDED");
  });
});
