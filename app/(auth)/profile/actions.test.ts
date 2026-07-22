import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient } from "@/lib/supabase/server";
import { upsertProfile } from "./actions";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({}),
}));

describe("upsertProfile optimistic concurrency", () => {
  const authUser = { id: crypto.randomUUID() };

  beforeEach(() => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockMaybeSingle = vi
      .fn()
      .mockResolvedValue({
        data: { user_id: authUser.id, updated_at: "now" },
      });
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: mockMaybeSingle,
      }),
      maybeSingle: mockMaybeSingle,
    });
    const mockFrom = vi.fn().mockReturnValue({
      select: mockSelect,
      upsert: mockUpsert,
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: authUser },
        }),
      },
      from: mockFrom,
    } as unknown as Awaited<ReturnType<typeof createClient>>);
  });

  const staleFormData = (expected: string, name = "New Name") => {
    const data = new FormData();
    data.set("expectedUpdatedAt", expected);
    data.set("name", name);
    data.set("bloodGroup", "unknown");
    data.set("genotype", "unknown");
    return data;
  };

  it("returns a conflict error when updated_at changed since form was loaded", async () => {
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: authUser },
        }),
      },
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { user_id: authUser.id, updated_at: "newer" } });
                  },
                };
              },
              maybeSingle() {
                return Promise.resolve({ data: { user_id: authUser.id, updated_at: "newer" } });
              },
            };
          },
        };
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await upsertProfile(undefined, staleFormData("stale"));

    expect(result).toEqual({
      error:
        "This profile was updated elsewhere since you loaded this page. Reload and reapply your changes before saving.",
    });
  });

  it("allows a save when the submitted updated_at matches the current row", async () => {
    let upsertCalls = 0;
    vi.mocked(createClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: authUser },
        }),
      },
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    return Promise.resolve({ data: { user_id: authUser.id, updated_at: "now" } });
                  },
                };
              },
              maybeSingle() {
                return Promise.resolve({ data: { user_id: authUser.id, updated_at: "now" } });
              },
            };
          },
          upsert() {
            upsertCalls += 1;
            return Promise.resolve({ error: null });
          },
        };
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await upsertProfile(undefined, staleFormData("now"));

    expect(result).toEqual({ success: true });
    expect(upsertCalls).toBe(1);
  });
});
