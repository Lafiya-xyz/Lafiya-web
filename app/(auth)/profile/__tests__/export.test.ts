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
    const eqSpy = vi.fn().mockReturnThis();
    const singleSpy = vi.fn().mockResolvedValue({
      data: { user_id: "user-123", full_name: "Test Patient" },
      error: null,
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq: eqSpy, single: singleSpy }),
      }),
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await exportMyProfileData();

    expect(eqSpy).toHaveBeenCalledWith("user_id", "user-123");
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.profile.user_id).toBe("user-123");
    }
  });
});