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

/**
 * public.profile_secrets stores the per-patient HMAC pepper backing
 * lib/attestation/recordHash.ts. It's deliberately RLS-enabled with ZERO
 * policies for any role — not even the owning patient can read their own
 * secret; only the service-role admin client (via
 * lib/attestation/recordSecret.ts) may ever touch it. That's the invariant
 * most likely to get "fixed" away by a future well-meaning contributor
 * (e.g. "let's add an owner-select policy so patients can see their own
 * pepper"), so this test asserts the *current, intended* behavior
 * explicitly rather than relying on the migration comment alone.
 */
describe("profile_secrets RLS", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser();
    const { error } = await user.client
      .from("profiles")
      .insert({ user_id: user.id, name: "Secret RLS Test" });
    if (error) {
      throw error;
    }
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it("a profile_secrets row is auto-provisioned once upsertProfile ensures one (simulated here directly, since this test doesn't go through the Server Action)", async () => {
    // upsertProfile calls ensureRecordSecret via the admin client; simulate
    // that directly here rather than importing the Next.js Server Action.
    const { error } = await adminClient
      .from("profile_secrets")
      .upsert(
        { user_id: user.id, secret: "a".repeat(64) },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
    expect(error).toBeNull();
  });

  it("denies anon direct table access entirely — no GRANT, not just no matching rows", async () => {
    const anon = createClient<Database>(url, anonKey);
    const { data, error } = await anon.from("profile_secrets").select("*");

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("denies the owning patient's own authenticated client — zero policies, not even owner-read", async () => {
    const { data, error } = await user.client
      .from("profile_secrets")
      .select("*")
      .eq("user_id", user.id);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("denies the owning patient's own authenticated client from writing, too", async () => {
    const { error } = await user.client
      .from("profile_secrets")
      .update({ secret: "b".repeat(64) })
      .eq("user_id", user.id);

    expect(error).not.toBeNull();
  });

  it("the service-role admin client can read the secret (the only legitimate reader)", async () => {
    const { data, error } = await adminClient
      .from("profile_secrets")
      .select("secret")
      .eq("user_id", user.id)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cascades away when the owning profiles row is deleted", async () => {
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(
      user.id,
    );
    expect(deleteError).toBeNull();

    const { data } = await adminClient
      .from("profile_secrets")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    expect(data).toBeNull();
  });
});
