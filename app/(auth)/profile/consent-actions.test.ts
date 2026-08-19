import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeCurrentPolicy,
  getMyConsentHistory,
} from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";

describe("consent profile actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes consent history to the authenticated user", async () => {
    const eq = vi.fn().mockReturnValue({
      order: vi.fn().mockResolvedValue({
        data: [
          {
            id: "consent-1",
            user_id: "user-123",
            policy_version: "ndpa-2023-v1",
            accepted_at: "2026-08-19T10:00:00.000Z",
          },
        ],
        error: null,
      }),
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ eq }),
      }),
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await getMyConsentHistory();

    expect(eq).toHaveBeenCalledWith("user_id", "user-123");
    expect("data" in result && result.data).toHaveLength(1);
  });

  it("treats duplicate acknowledgement as idempotent success", async () => {
    const insert = vi.fn().mockResolvedValue({
      error: { code: "23505", message: "duplicate" },
    });

    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: "user-123" } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({ insert }),
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    const result = await acknowledgeCurrentPolicy(undefined, new FormData());

    expect(insert).toHaveBeenCalledWith({
      user_id: "user-123",
      policy_version: "ndpa-2023-v1",
    });
    expect(result).toEqual({ success: true });
  });

  it("rejects unauthenticated acknowledgement", async () => {
    vi.mocked(createClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: null },
          error: null,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof createClient>>);

    await expect(
      acknowledgeCurrentPolicy(undefined, new FormData()),
    ).resolves.toEqual({ error: "Not authenticated" });
  });
});
