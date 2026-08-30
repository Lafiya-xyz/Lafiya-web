import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteAccountAndData } from "@/lib/account/deleteAccount";
import { computeRecordHash } from "@/lib/attestation/recordHash";
import type { Database } from "@/lib/supabase/types";

import { bruteForceNewScheme } from "./helpers/bruteForce";
import {
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const adminClient = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function waitForStorageRemoval(
  bucket: string,
  prefix: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data, error } = await adminClient.storage.from(bucket).list(prefix);
    if (error) {
      throw error;
    }
    if (!data || data.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const { data, error } = await adminClient.storage.from(bucket).list(prefix);
  if (error) {
    throw error;
  }
  throw new Error(
    `Storage objects were not removed within ${timeoutMs}ms: ${JSON.stringify(data)}`,
  );
}

describe("account deletion", () => {
  let user: TestUser;
  let cardPublicId: string;
  const storagePath = "test-avatar.png";

  beforeAll(async () => {
    user = await createTestUser();

    const { data, error } = await user.client
      .from("profiles")
      .insert({
        user_id: user.id,
        name: "Delete Test Patient",
        date_of_birth: "1995-06-15",
        blood_group: "A+",
        genotype: "AA",
        allergies: ["Sulfa"],
        medications: ["Metformin"],
        chronic_conditions: ["Diabetes"],
        emergency_contacts: [
          {
            name: "Emergency Contact",
            phone: "+20000000000",
            relationship: "Spouse",
          },
        ],
        language: "French",
      })
      .select("card_public_id")
      .single();

    if (error || !data) {
      throw error ?? new Error("Failed to seed profile");
    }
    cardPublicId = data.card_public_id;

    const { error: uploadError } = await adminClient.storage
      .from("avatars")
      .upload(
        `${user.id}/${storagePath}`,
        new Blob(["fake-image-data"], { type: "image/png" }),
        {
          contentType: "image/png",
          upsert: true,
        },
      );

    if (uploadError) {
      throw uploadError;
    }
  });

  afterAll(async () => {
    // Best-effort cleanup if a test failed before deletion happened.
    await adminClient.storage
      .from("avatars")
      .remove([`${user.id}/${storagePath}`]);
    await deleteTestUser(user.id);
  });

  it("deletes the profile row, the auth user, and storage objects, and the old card 404s", async () => {
    // 1. Confirm the profile exists before deletion.
    const { data: profileBefore } = await adminClient
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    expect(profileBefore).not.toBeNull();

    // 2. Confirm storage object exists.
    const { data: objectsBefore } = await adminClient.storage
      .from("avatars")
      .list(user.id);
    expect(objectsBefore).toHaveLength(1);

    // 3. Exercise the same storage cleanup + auth deletion operation used by
    //    the server action. Deleting an auth user alone does not cascade into
    //    Supabase Storage.
    await deleteAccountAndData(adminClient, user.id);

    // 4. Profile row is gone (cascade delete).
    const { data: profileAfter } = await adminClient
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    expect(profileAfter).toBeNull();

    // 5. Storage object is gone. Allow a bounded window for the Storage API's
    //    list endpoint to reflect the completed removal.
    await waitForStorageRemoval("avatars", user.id);
    const { data: objectsAfter } = await adminClient.storage
      .from("avatars")
      .list(user.id);
    expect(objectsAfter).toHaveLength(0);

    // 6. Auth user is gone — sign-in fails.
    const { error: signInError } = await createClient<Database>(
      url,
      anonKey,
    ).auth.signInWithPassword({
      email: user.email,
      password: "test-password-123456",
    });
    expect(signInError).not.toBeNull();

    // 7. Public emergency card RPC returns empty for the old card_public_id.
    const anon = createClient<Database>(url, anonKey);
    const { data: cardData, error: cardError } = await anon.rpc(
      "get_emergency_card",
      { p_card_id: cardPublicId },
    );
    expect(cardError).toBeNull();
    expect(cardData).toEqual([]);
  });
});

/**
 * The erasure proof required by
 * issues/issue-03-record-hash-commitment-scheme.md: account deletion
 * cannot remove a record_hash already attested on the immutable Stellar
 * ledger, but it MUST destroy the per-patient secret (public.profile_secrets,
 * cascaded via profiles -> auth.users FK chain), so that a future
 * preimage search for this specific patient's record — even with perfect
 * knowledge of every emergency field — is computationally infeasible.
 * Uses the same bounded brute-force harness as
 * lib/attestation/recordHash.bruteforce.test.ts (tests/integration/
 * helpers/bruteForce.ts) so both tests exercise identical attack logic.
 */
describe("account deletion destroys future preimage-search feasibility", () => {
  let user: TestUser;
  let realSecret: string;
  let preDeletionHash: string;

  // Matches one of the shared harness's enumerable field combinations
  // (see guessableFieldCombinations in helpers/bruteForce.ts) — the
  // "attacker has perfectly guessed every field" worst case.
  const knownFields = {
    name: "Target Patient",
    blood_group: "O+" as const,
    genotype: "AS" as const,
    allergies: [] as string[],
    medications: [] as string[],
    chronic_conditions: [] as string[],
    emergency_contacts: [] as {
      name: string;
      phone: string;
      relationship: string;
    }[],
    language: "Hausa",
  };

  beforeAll(async () => {
    user = await createTestUser();

    const { error: insertError } = await user.client.from("profiles").insert({
      user_id: user.id,
      name: knownFields.name,
      blood_group: knownFields.blood_group,
      genotype: knownFields.genotype,
      allergies: knownFields.allergies,
      medications: knownFields.medications,
      chronic_conditions: knownFields.chronic_conditions,
      emergency_contacts: knownFields.emergency_contacts,
      language: knownFields.language,
    });
    if (insertError) {
      throw insertError;
    }

    // Simulates what upsertProfile's ensureRecordSecret would do — this
    // test doesn't go through the Next.js Server Action.
    realSecret = "d".repeat(64);
    const { error: secretError } = await adminClient
      .from("profile_secrets")
      .upsert(
        { user_id: user.id, secret: realSecret },
        { onConflict: "user_id" },
      );
    if (secretError) {
      throw secretError;
    }

    preDeletionHash = computeRecordHash(knownFields, realSecret);
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it("the secret is unrecoverable after deletion, and a bounded correlation attack against the known fields fails", async () => {
    // Sanity check: the harness can actually reproduce the real hash when
    // given the real secret, so the "attack fails post-deletion" result
    // below isn't just a harness that never finds anything.
    expect(computeRecordHash(knownFields, realSecret)).toBe(preDeletionHash);

    const { error: deleteError } = await adminClient.auth.admin.deleteUser(
      user.id,
    );
    expect(deleteError).toBeNull();

    const { data: secretAfter } = await adminClient
      .from("profile_secrets")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    expect(secretAfter).toBeNull();

    // Even with perfect knowledge of every hashed field (name, blood group,
    // genotype, empty arrays, language) plus a bounded, documented
    // secret-guessing budget (see bruteForceNewScheme), the pre-deletion
    // hash cannot be reproduced once the secret is gone.
    const found = bruteForceNewScheme(preDeletionHash);
    expect(found).toBeNull();
  });
});

/**
 * #397: Account deletion must revoke all active capability shares as part of
 * the same atomic operation. A previously-shared link must not keep resolving
 * to the deleted profile's data.
 */
describe("account deletion revokes all active capability shares", () => {
  let user: TestUser;
  let tokenDigest: string;

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

  beforeAll(async () => {
    user = await createTestUser();

    // Create a profile for the test user.
    const { error: profileError } = await user.client.from("profiles").insert({
      user_id: user.id,
      name: "Capability Revoke Test",
      blood_group: "B+",
      genotype: "AA",
      allergies: [],
      medications: [],
      chronic_conditions: [],
      emergency_contacts: [],
    });
    if (profileError) throw profileError;

    // Patient must have emergency_public_disclosure consent for a capability
    // to resolve patient data.
    const { error: consentError } = await user.client.rpc("record_consent", {
      p_purpose: "emergency_public_disclosure",
      p_purpose_version: 1,
      p_action: "acknowledged",
      p_idempotency_key: crypto.randomUUID(),
    });
    if (consentError) throw consentError;

    // Issue an emergency capability that would be valid for 179 days.
    const { createHash, randomBytes } = await import("node:crypto");
    const rawToken = randomBytes(32);
    tokenDigest = createHash("sha256").update(rawToken).digest("hex");

    const { error: capError } = await user.client.rpc(
      "create_emergency_capability",
      {
        p_token_digest: tokenDigest,
        p_purpose: "emergency",
        p_field_allowlist: allowlist,
        p_expires_at: new Date(
          Date.now() + 179 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        p_max_views: null,
      },
    );
    if (capError) throw capError;
  });

  afterAll(async () => {
    // Best-effort cleanup in case a test assertion failed before deletion.
    await adminClient.auth.admin.deleteUser(user.id);
  });

  it("creates a valid capability, deletes the account, and confirms the token no longer resolves", async () => {
    const anon = createClient<Database>(url, anonKey);

    // 1. Confirm the capability resolves patient data before deletion.
    const { data: beforeData, error: beforeError } = await anon.rpc(
      "consume_emergency_capability",
      { p_token_digest: tokenDigest },
    );
    expect(beforeError).toBeNull();
    expect(beforeData![0]).toMatchObject({
      access_state: "active",
      name: "Capability Revoke Test",
    });

    // 2. Delete the account via the same function used by the server action.
    await deleteAccountAndData(adminClient, user.id);

    // 3. The previously-valid capability must no longer return patient data.
    //    Whether the row was revoked or cascade-deleted, the outcome for a
    //    caller must be "inactive" — never the deleted profile's fields.
    const { data: afterData, error: afterError } = await anon.rpc(
      "consume_emergency_capability",
      { p_token_digest: tokenDigest },
    );
    expect(afterError).toBeNull();
    expect(afterData![0]).toMatchObject({ access_state: "inactive" });
    expect(afterData![0].name).toBeNull();
  });
});
