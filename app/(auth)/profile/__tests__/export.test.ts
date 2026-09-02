import { describe, it, expect, vi } from "vitest";
import { exportMyProfileData } from "../actions";

// Mock the Supabase server client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

import { createClient } from "@/lib/supabase/server";

describe("exportMyProfileData", () => {
  it("returns an error when not authenticated", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await exportMyProfileData();
    expect("error" in result).toBe(true);
  });

  it("only fetches the caller's own row (scoped by user_id = auth.uid())", async () => {
    const eqSpy = vi.fn();
    const profile = {
      user_id: "user-123",
      name: "Test Patient",
      disclosure_policy: { version: 1, fields: {} },
    };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn((_field: string, value: string) => {
          eqSpy(_field, value);
          return table === "profiles"
            ? {
                single: vi
                  .fn()
                  .mockResolvedValue({ data: profile, error: null }),
              }
            : { order: vi.fn().mockResolvedValue({ data: [], error: null }) };
        }),
      })),
    }));

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from,
      storage: {
        from: vi.fn().mockReturnValue({
          list: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await exportMyProfileData();

    expect(eqSpy).toHaveBeenCalledWith("user_id", "user-123");
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.profile.user_id).toBe("user-123");
      expect(result.data.schemaVersion).toBe(2);
      expect(result.data.checksum.value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // Documented in docs/data-export-schema.md ("`profile` field set"). Kept
  // as an explicit list here so a future `select("*")` regression on
  // `profiles` is caught even though this test mocks Supabase (and can't
  // rely on real Postgrest column filtering).
  const DOCUMENTED_PROFILE_FIELDS = [
    "user_id",
    "card_public_id",
    "name",
    "date_of_birth",
    "photo_url",
    "language",
    "blood_group",
    "genotype",
    "allergies",
    "medications",
    "chronic_conditions",
    "emergency_contacts",
    "last_verified_at",
    "created_at",
    "updated_at",
    "current_revision_id",
    "disclosure_policy",
    "legacy_card_sunset_at",
  ].sort();

  it("only returns the exact field set documented in docs/data-export-schema.md, never internal/admin-only columns", async () => {
    // Simulates the real Postgrest row: includes internal-only columns
    // (e.g. last_attested_hash, an attestation-reconciliation value that
    // must never reach a patient export) alongside the legitimate ones.
    // The `select()` mock below mimics Postgrest by only returning the
    // columns actually named in the select string, so this test fails if
    // the export path ever regresses to `select("*")`.
    const fullRow: Record<string, unknown> = {
      user_id: "user-123",
      card_public_id: "card-abc",
      name: "Test Patient",
      date_of_birth: null,
      photo_url: null,
      language: null,
      blood_group: "O+",
      genotype: "AA",
      allergies: [],
      medications: [],
      chronic_conditions: [],
      emergency_contacts: [],
      last_verified_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      current_revision_id: null,
      disclosure_policy: { version: 1, fields: {} },
      legacy_card_sunset_at: "2027-01-01T00:00:00Z",
      // internal-only columns that must never leak into the export:
      last_attested_hash: "deadbeef".repeat(8),
    };

    const from = vi.fn((table: string) => ({
      select: vi.fn((columns: string) => ({
        eq: vi.fn(() => {
          if (table !== "profiles") {
            return { order: vi.fn().mockResolvedValue({ data: [], error: null }) };
          }
          const requested = columns.split(",");
          const filtered = Object.fromEntries(
            requested.map((key) => [key, fullRow[key]]),
          );
          return { single: vi.fn().mockResolvedValue({ data: filtered, error: null }) };
        }),
      })),
    }));

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from,
      storage: {
        from: vi.fn().mockReturnValue({
          list: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await exportMyProfileData();

    expect("data" in result).toBe(true);
    if (!("data" in result)) return;

    const actualKeys = Object.keys(result.data.profile).sort();
    expect(actualKeys).toEqual(DOCUMENTED_PROFILE_FIELDS);
    expect(result.data.profile).not.toHaveProperty("last_attested_hash");
  });
});
