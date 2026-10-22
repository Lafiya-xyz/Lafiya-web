import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

// walk_in_cards is not yet in the generated Database types.
const untyped = (c: unknown) => c as SupabaseClient;

/** Issue #770: once a patient claims a walk-in card the CHW loses all access. */
describe("walk-in card claim RLS", () => {
  let chw: TestUser;
  let patient: TestUser;
  let cardId: string;

  beforeAll(async () => {
    chw = await createTestUser();
    patient = await createTestUser();
    const { data, error } = await untyped(adminClient)
      .from("walk_in_cards")
      .insert({
        custodian_id: chw.id,
        fields: { name: "Walk-in" },
        claim_code_hash: "a".repeat(64),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    cardId = data.id;
  });

  afterAll(async () => {
    await deleteTestUser(chw.id);
    await deleteTestUser(patient.id);
  });

  it("custodian can read before the claim; patient cannot", async () => {
    const { data } = await untyped(chw.client)
      .from("walk_in_cards")
      .select("id")
      .eq("id", cardId);
    expect(data).toHaveLength(1);
    const { data: p } = await untyped(patient.client)
      .from("walk_in_cards")
      .select("id")
      .eq("id", cardId);
    expect(p).toHaveLength(0);
  });

  it("after claim the CHW can no longer read or edit", async () => {
    const { data: ok, error } = await untyped(adminClient).rpc(
      "claim_walk_in_card",
      {
        p_card_id: cardId,
        p_patient_id: patient.id,
      },
    );
    expect(error).toBeNull();
    expect(ok).toBe(true);

    const { data: read } = await untyped(chw.client)
      .from("walk_in_cards")
      .select("id")
      .eq("id", cardId);
    expect(read).toHaveLength(0);
    const { data: updated } = await untyped(chw.client)
      .from("walk_in_cards")
      .update({ fields: { name: "tampered" } })
      .eq("id", cardId)
      .select("id");
    expect(updated ?? []).toHaveLength(0);

    const { data: owned } = await untyped(patient.client)
      .from("walk_in_cards")
      .select("fields")
      .eq("id", cardId);
    expect(owned).toEqual([{ fields: { name: "Walk-in" } }]);

    const { data: again } = await untyped(adminClient).rpc(
      "claim_walk_in_card",
      {
        p_card_id: cardId,
        p_patient_id: chw.id,
      },
    );
    expect(again).toBe(false);
  });
});
