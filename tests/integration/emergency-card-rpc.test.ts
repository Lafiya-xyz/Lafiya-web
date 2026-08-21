import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import {
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const EXPECTED_KEYS = [
  "name",
  "age",
  "photo_url",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
  "emergency_contacts",
  "language",
  "disclosure_states",
  "revision_id",
  "schema_version",
  "commitment",
  "offline_cache_allowed",
].sort();

describe("get_emergency_card RPC", () => {
  let user: TestUser;
  let cardPublicId: string;

  beforeAll(async () => {
    user = await createTestUser();

    const { data, error } = await user.client
      .from("profiles")
      .insert({
        user_id: user.id,
        name: "Test Patient",
        date_of_birth: "2000-01-01",
        blood_group: "O+",
        genotype: "AS",
        allergies: ["Penicillin"],
        medications: ["Insulin"],
        chronic_conditions: ["Asthma"],
        emergency_contacts: [
          {
            name: "Contact One",
            phone: "+10000000000",
            relationship: "Friend",
          },
        ],
        language: "English",
      })
      .select("card_public_id")
      .single();

    if (error || !data) {
      throw error ?? new Error("Failed to seed test profile");
    }
    cardPublicId = data.card_public_id;
    const { error: consentError } = await user.client.rpc("record_consent", {
      p_purpose: "emergency_public_disclosure",
      p_purpose_version: 1,
      p_action: "acknowledged",
      p_idempotency_key: crypto.randomUUID(),
    });
    if (consentError) throw consentError;
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it("is callable by anon (no auth required) and returns the emergency subset for a valid id", async () => {
    const anon = createClient<Database>(url, anonKey);
    const { data, error } = await anon.rpc("get_emergency_card", {
      p_card_id: cardPublicId,
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      name: "Test Patient",
      blood_group: "O+",
      genotype: "AS",
      allergies: ["Penicillin"],
      medications: ["Insulin"],
      chronic_conditions: ["Asthma"],
      language: "English",
    });
  });

  it("returns no extra columns — never user_id, card_public_id, or timestamps", async () => {
    const anon = createClient<Database>(url, anonKey);
    const { data } = await anon.rpc("get_emergency_card", {
      p_card_id: cardPublicId,
    });

    expect(Object.keys(data![0]).sort()).toEqual(EXPECTED_KEYS);
  });

  it("returns an empty array for an unknown card id", async () => {
    const anon = createClient<Database>(url, anonKey);
    const { data, error } = await anon.rpc("get_emergency_card", {
      p_card_id: "00000000-0000-0000-0000-000000000000",
    });

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
