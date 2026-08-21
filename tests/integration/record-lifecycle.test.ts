import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient } from "@supabase/supabase-js";
import type { Database, ProfileRow } from "@/lib/supabase/types";
import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

describe("governed record lifecycle", () => {
  let owner: TestUser;
  let other: TestUser;
  let profile: ProfileRow;

  beforeAll(async () => {
    owner = await createTestUser();
    other = await createTestUser();
    const { error } = await owner.client
      .from("profiles")
      .insert({ user_id: owner.id, name: "Concurrency Patient" })
      .select("*")
      .single();
    if (error) throw error;
    const refreshed = await owner.client
      .from("profiles")
      .select("*")
      .eq("user_id", owner.id)
      .single();
    if (refreshed.error) throw refreshed.error;
    profile = refreshed.data;
  });

  afterAll(async () => {
    await deleteTestUser(owner.id);
    await deleteTestUser(other.id);
  });

  it("accepts exactly one of fifty successors to the same base revision", async () => {
    const emergency = {
      name: "Concurrency Patient",
      date_of_birth: null,
      photo_url: null,
      language: null,
      blood_group: "unknown",
      genotype: "unknown",
      allergies: [],
      medications: [],
      chronic_conditions: [],
      emergency_contacts: [],
    };
    const attempts = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        owner.client.rpc("save_record_revision", {
          p_expected_revision_id: profile.current_revision_id,
          p_emergency_data: { ...emergency, name: `Concurrency Patient ${i}` },
          p_provenance: {},
          p_disclosure_policy: profile.disclosure_policy,
          p_commitment: i.toString(16).padStart(64, "0"),
        }),
      ),
    );
    expect(attempts.filter((result) => !result.error)).toHaveLength(1);
    expect(
      attempts
        .filter((result) => result.error)
        .every((result) => result.error?.code === "40001"),
    ).toBe(true);
    const revisions = await adminClient
      .from("record_revisions")
      .select("id")
      .eq("user_id", owner.id);
    expect(revisions.data).toHaveLength(2);
  });

  it("denies cross-user and anonymous revision/consent reads", async () => {
    const ownerRows = await owner.client.from("record_revisions").select("id");
    const otherRows = await other.client.from("record_revisions").select("id");
    const anon = createClient<Database>(url, anonKey);
    const anonRows = await anon.from("record_revisions").select("id");
    expect(ownerRows.data?.length).toBeGreaterThan(0);
    expect(otherRows.data).toEqual([]);
    expect(anonRows.error).not.toBeNull();
  });

  it("withdrawal immediately makes the public card unavailable", async () => {
    const card = await owner.client
      .from("profiles")
      .select("card_public_id")
      .eq("user_id", owner.id)
      .single();
    await owner.client.rpc("record_consent", {
      p_purpose: "emergency_public_disclosure",
      p_purpose_version: 1,
      p_action: "acknowledged",
      p_idempotency_key: crypto.randomUUID(),
    });
    const anon = createClient<Database>(url, anonKey);
    expect(
      (
        await anon.rpc("get_emergency_card", {
          p_card_id: card.data!.card_public_id,
        })
      ).data,
    ).toHaveLength(1);
    await owner.client.rpc("record_consent", {
      p_purpose: "emergency_public_disclosure",
      p_purpose_version: 1,
      p_action: "withdrawn",
      p_idempotency_key: crypto.randomUUID(),
    });
    expect(
      (
        await anon.rpc("get_emergency_card", {
          p_card_id: card.data!.card_public_id,
        })
      ).data,
    ).toEqual([]);
  });
});
