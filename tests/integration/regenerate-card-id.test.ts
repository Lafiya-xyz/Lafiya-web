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

describe("card_public_id regeneration", () => {
  let user: TestUser;
  let oldCardId: string;

  beforeAll(async () => {
    user = await createTestUser();

    const { data, error } = await user.client
      .from("profiles")
      .insert({
        user_id: user.id,
        name: "Regeneration Test Patient",
        date_of_birth: "1995-06-15",
        blood_group: "A+",
        genotype: "AA",
        allergies: ["Sulfa"],
        medications: [],
        chronic_conditions: [],
        emergency_contacts: [],
      })
      .select("card_public_id")
      .single();

    if (error || !data) {
      throw error ?? new Error("Failed to seed test profile");
    }
    oldCardId = data.card_public_id;
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

  it("old card_public_id returns data before regeneration", async () => {
    const anon = createClient<Database>(url, anonKey);
    const { data, error } = await anon.rpc("get_emergency_card", {
      p_card_id: oldCardId,
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].name).toBe("Regeneration Test Patient");
  });

  it("regenerates card_public_id and the old id no longer resolves", async () => {
    const newId = crypto.randomUUID();

    const { error } = await user.client
      .from("profiles")
      .update({ card_public_id: newId })
      .eq("user_id", user.id);

    expect(error).toBeNull();

    const anon = createClient<Database>(url, anonKey);

    // Old id should return empty — no longer resolves
    const { data: oldResult, error: oldError } = await anon.rpc(
      "get_emergency_card",
      { p_card_id: oldCardId },
    );
    expect(oldError).toBeNull();
    expect(oldResult).toEqual([]);

    // New id should resolve
    const { data: newResult, error: newError } = await anon.rpc(
      "get_emergency_card",
      { p_card_id: newId },
    );
    expect(newError).toBeNull();
    expect(newResult).toHaveLength(1);
    expect(newResult![0].name).toBe("Regeneration Test Patient");
  });
});
