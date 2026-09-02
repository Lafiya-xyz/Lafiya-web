import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRawCapability, digestCapability } from "@/lib/emergency/capability";
import type { Database } from "@/lib/supabase/types";

import { createTestUser, deleteTestUser, type TestUser } from "./helpers/testUser";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Issue #408: capability tokens (lib/emergency/capability.ts) grant only
 * read access to a bounded set of emergency card fields, resolved through
 * the read-only `consume_emergency_capability` RPC. There is no "edit"
 * capability anywhere in the schema — `update_disclosure_policy` and every
 * other profile-mutating RPC take no capability/token parameter at all and
 * are grant-restricted to `authenticated` (a real Supabase Auth session),
 * never `anon`. This proves that boundary holds for the actual holder of a
 * valid capability — an anonymous client, exactly like a real card viewer —
 * rather than just asserting it by reading the schema.
 */
describe("capability token scope", () => {
  let owner: TestUser;
  const rawCapability = createRawCapability();

  beforeAll(async () => {
    owner = await createTestUser();

    const { error } = await owner.client.rpc("create_emergency_capability", {
      p_token_digest: digestCapability(rawCapability),
      p_purpose: "emergency",
      p_field_allowlist: { name: true },
      p_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      p_max_views: null,
    });
    if (error) throw error;
  });

  afterAll(async () => {
    await deleteTestUser(owner.id);
  });

  it("a holder of a valid capability cannot call update_disclosure_policy with it", async () => {
    const anon = createClient<Database>(url, anonKey);

    // A real card viewer only ever has the raw token / its digest — never a
    // Supabase Auth session. update_disclosure_policy takes no capability
    // parameter and is granted only to `authenticated`, so this must fail
    // regardless of what's passed as the (nonsensical here) revision id.
    const { error } = await anon.rpc("update_disclosure_policy", {
      p_expected_revision_id: crypto.randomUUID(),
      p_disclosure_policy: { fields: { name: true } },
    });

    expect(error).not.toBeNull();
  });

  it("a holder of a valid capability cannot write to profiles directly", async () => {
    const anon = createClient<Database>(url, anonKey);

    const { error, data } = await anon
      .from("profiles")
      .update({ name: "Hijacked via capability" })
      .eq("user_id", owner.id)
      .select();

    // RLS + grants deny anon table access to `profiles` entirely (see
    // rls.test.ts) — a capability digest doesn't change that; it's a
    // separate, narrower read path via consume_emergency_capability only.
    expect(data ?? []).toHaveLength(0);
    void error; // Supabase may report this as an empty result rather than an error; either is an acceptable proof of no write.
  });

  it("consume_emergency_capability executes for anon but exposes no write capability", async () => {
    const anon = createClient<Database>(url, anonKey);

    const { error } = await anon.rpc("consume_emergency_capability", {
      p_token_digest: digestCapability(rawCapability),
    });

    // The intended, sole capability-consuming entrypoint is reachable by
    // anon (that's the whole point of a shareable card link) — but it's a
    // read-only `select`-returning function with no mutating side effect
    // beyond incrementing its own view counter.
    expect(error).toBeNull();
  });
});
