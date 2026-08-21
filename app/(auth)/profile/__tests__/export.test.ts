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
});
