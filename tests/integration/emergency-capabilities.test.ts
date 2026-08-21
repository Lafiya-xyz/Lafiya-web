import { createHash, randomBytes } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const allowlist = {
  name: true,
  age: true,
  photo_url: true,
  blood_group: true,
  genotype: true,
  allergies: true,
  medications: true,
  chronic_conditions: true,
  emergency_contacts: true,
  language: true,
};

function digest(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

describe("emergency capabilities and access accountability", () => {
  let owner: TestUser;
  let otherUser: TestUser;
  let capabilityId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    otherUser = await createTestUser();
    const { error } = await owner.client.from("profiles").insert({
      user_id: owner.id,
      name: "Capability Test Patient",
      blood_group: "O+",
      genotype: "AS",
      allergies: ["Penicillin"],
      medications: [],
      chronic_conditions: [],
      emergency_contacts: [],
    });
    if (error) throw error;
    const { error: consentError } = await owner.client.rpc("record_consent", {
      p_purpose: "emergency_public_disclosure",
      p_purpose_version: 1,
      p_action: "acknowledged",
      p_idempotency_key: crypto.randomUUID(),
    });
    if (consentError) throw consentError;
    const { data, error: capabilityError } = await owner.client.rpc(
      "create_emergency_capability",
      {
        p_token_digest: digest(),
        p_purpose: "temporary",
        p_field_allowlist: allowlist,
        p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        p_max_views: 1,
      },
    );
    if (capabilityError || !data)
      throw capabilityError ?? new Error("Capability creation failed");
    capabilityId = data.id;
  });

  afterAll(async () => {
    await deleteTestUser(owner.id);
    await deleteTestUser(otherUser.id);
  });

  it("stores only a digest, atomically exhausts a bounded capability, and never returns owner identity", async () => {
    const rawDigest = digest();
    const { error } = await owner.client.rpc("create_emergency_capability", {
      p_token_digest: rawDigest,
      p_purpose: "temporary",
      p_field_allowlist: allowlist,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      p_max_views: 1,
    });
    expect(error).toBeNull();

    const anon = createClient<Database>(url, anonKey);
    const { data: first, error: firstError } = await anon.rpc(
      "consume_emergency_capability",
      { p_token_digest: rawDigest },
    );
    expect(firstError).toBeNull();
    expect(first![0]).toMatchObject({
      access_state: "active",
      name: "Capability Test Patient",
      blood_group: "O+",
    });
    expect(first![0]).not.toHaveProperty("user_id");
    expect(first![0]).not.toHaveProperty("token_digest");

    const { data: second } = await anon.rpc("consume_emergency_capability", {
      p_token_digest: rawDigest,
    });
    expect(second![0]).toMatchObject({ access_state: "inactive", name: null });
  });

  it("enforces owner-only capability and access-summary visibility", async () => {
    const { data: crossTenantCapabilities, error } = await otherUser.client
      .from("emergency_capabilities")
      .select("id")
      .eq("id", capabilityId);
    expect(error).toBeNull();
    expect(crossTenantCapabilities).toEqual([]);

    const { error: eventError } = await adminClient.rpc(
      "record_card_access_event",
      {
        p_capability_id: capabilityId,
        p_access_kind: "capability",
        p_outcome: "served",
      },
    );
    expect(eventError).toBeNull();
    const { data: ownerSummary } = await owner.client.rpc(
      "get_my_card_access_summary",
    );
    const { data: otherSummary } = await otherUser.client.rpc(
      "get_my_card_access_summary",
    );
    expect(ownerSummary![0].views_last_30_days).toBeGreaterThanOrEqual(1);
    expect(otherSummary![0].views_last_30_days).toBe(0);
  });

  it("rejects capability policies that exceed their purpose lifetime", async () => {
    const { error } = await owner.client.rpc("create_emergency_capability", {
      p_token_digest: digest(),
      p_purpose: "temporary",
      p_field_allowlist: allowlist,
      p_expires_at: new Date(
        Date.now() + 31 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      p_max_views: 1,
    });
    expect(error?.message).toContain("INVALID_TEMPORARY_CAPABILITY_POLICY");
  });
});
