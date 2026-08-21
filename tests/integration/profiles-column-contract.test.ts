import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import type { EmergencyCardRow, ProfileRow } from "@/lib/supabase/types";

import {
  adminClient,
  createTestUser,
  deleteTestUser,
  type TestUser,
} from "./helpers/testUser";

/**
 * Contract test guarding public.get_emergency_card against column leakage.
 *
 * The RPC (supabase/migrations/20260709110953_emergency_card_rpc.sql) is
 * deliberately written with an explicit column list — never `select *` — so
 * a future `alter table profiles add column ...` cannot silently leak a new
 * sensitive column through the public, unauthenticated path. That invariant
 * previously lived only in a SQL comment; this test enforces it: every live
 * column of public.profiles must be explicitly classified below as either
 * exposed via the emergency card or intentionally private.
 *
 * IF THIS TEST FAILS after adding a column to public.profiles:
 *   1. Decide whether a stranger scanning the QR code should see the new
 *      column. Default to INTENTIONALLY_PRIVATE unless there is a clear
 *      emergency-care reason to expose it.
 *   2. Add the column to exactly one of the two lists below.
 *   3. If exposing it, also add it to the RPC's explicit column list (new
 *      migration) and to EmergencyCardRow in lib/supabase/types.ts.
 *   4. Either way, add it to ProfileRow in lib/supabase/types.ts — the
 *      compile-time assertions here keep schema, RPC, and TS types in
 *      lockstep.
 */

/** Columns of public.profiles the public RPC is allowed to return. */
const EXPOSED_VIA_EMERGENCY_CARD = [
  "name",
  "photo_url",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
  "emergency_contacts",
  "language",
] as const satisfies readonly (keyof ProfileRow & keyof EmergencyCardRow)[];

/** Columns that must never reach the public, unauthenticated path. */
const INTENTIONALLY_PRIVATE = [
  "user_id",
  "card_public_id",
  // Only the derived `age` is public; the exact birth date is not.
  "date_of_birth",
  "created_at",
  "updated_at",
  // Attestation bookkeeping (issue-03): only meaningful to the owning
  // patient's own /profile page (staleness detection), never to an
  // anonymous card scan.
  "last_attested_hash",
  "last_verified_at",
  "current_revision_id",
  "disclosure_policy",
  "legacy_card_sunset_at",
] as const satisfies readonly (keyof ProfileRow)[];

const ALL_CLASSIFIED_COLUMNS = [
  ...EXPOSED_VIA_EMERGENCY_CARD,
  ...INTENTIONALLY_PRIVATE,
].sort();

describe("profiles column contract (get_emergency_card leak guard)", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser();
    const { error } = await user.client
      .from("profiles")
      .insert({ user_id: user.id, name: "Contract Test" });
    if (error) {
      throw error;
    }
  });

  afterAll(async () => {
    await deleteTestUser(user.id);
  });

  it("every live column of public.profiles is explicitly classified", async () => {
    // `select("*")` through the service role returns every column of the
    // live table, so a migration that adds a column fails this assertion
    // before any TypeScript type or allowlist is touched.
    const { data, error } = await adminClient
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();

    expect(error).toBeNull();
    expect(Object.keys(data!).sort()).toEqual(ALL_CLASSIFIED_COLUMNS);
  });

  it("keeps the classification in lockstep with lib/supabase/types.ts", () => {
    // Compile-time (enforced by `npm run typecheck`): every ProfileRow key
    // is classified above, and the RPC's row type is exactly the exposed
    // columns plus the derived `age`.
    expectTypeOf<(typeof ALL_CLASSIFIED_COLUMNS)[number]>().toEqualTypeOf<
      keyof ProfileRow
    >();
    expectTypeOf<keyof EmergencyCardRow>().toEqualTypeOf<
      | (typeof EXPOSED_VIA_EMERGENCY_CARD)[number]
      | "age"
      | "disclosure_states"
      | "schema_version"
      | "offline_cache_allowed"
      | "trust_state"
      | "trust_updated_at"
      | "record_updated_at"
      | "authorization_expires_at"
    >();
  });
});
