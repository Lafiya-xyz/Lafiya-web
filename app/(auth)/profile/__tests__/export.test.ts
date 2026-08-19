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

  it("scopes both profile and consent reads to the authenticated caller", async () => {
    const profileEqSpy = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { user_id: "user-123", full_name: "Test Patient" },
        error: null,
      }),
    });
    const consentOrderSpy = vi.fn().mockResolvedValue({ data: [], error: null });
    const consentEqSpy = vi.fn().mockReturnValue({ order: consentOrderSpy });
    const fromSpy = vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnValue({ eq: profileEqSpy }),
        };
      }

      return {
        select: vi.fn().mockReturnValue({ eq: consentEqSpy }),
      };
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from: fromSpy,
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await exportMyProfileData();

    expect(profileEqSpy).toHaveBeenCalledWith("user_id", "user-123");
    expect(consentEqSpy).toHaveBeenCalledWith("user_id", "user-123");
    expect(consentOrderSpy).toHaveBeenCalledWith("accepted_at", {
      ascending: true,
    });
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.profile.user_id).toBe("user-123");
      expect(result.data.consentLogs).toEqual([]);
    }
  });

  it("exports consent policy versions and ISO timestamps without modification", async () => {
    const consentLogs = [
      {
        id: "consent-1",
        user_id: "user-123",
        policy_version: "2026-08",
        accepted_at: "2026-08-19T08:00:00.000Z",
      },
    ];

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue(
            table === "profiles"
              ? {
                  single: vi.fn().mockResolvedValue({
                    data: { user_id: "user-123" },
                    error: null,
                  }),
                }
              : {
                  order: vi.fn().mockResolvedValue({
                    data: consentLogs,
                    error: null,
                  }),
                },
          ),
        }),
      })),
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await exportMyProfileData();

    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.schemaVersion).toBe(2);
      expect(result.data.consentLogs).toEqual(consentLogs);
    }
  });
});
