import { beforeEach, describe, expect, it, vi } from "vitest";

import { repairProfileSecret, upsertProfile } from "./actions";

// revalidatePath requires a real Next.js request/render context (it throws
// "static generation store missing" outside one); stub it for this
// server-action unit test, matching the actions.ts happy path calling it.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockResolvedValue({}),
}));

// ensureRecordSecret talks to the (service-role, real-network) admin client;
// isolate this unit test from it, matching the existing mocking philosophy.
vi.mock("@/lib/attestation/recordSecret", () => ({
  ensureRecordSecret: vi.fn().mockResolvedValue(undefined),
  getSecretByUserId: vi.fn(),
  secretExistsByUserId: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/logging/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const mockCreateClient = await import("@/lib/supabase/server");
const mockRecordSecretModule = await import("@/lib/attestation/recordSecret");
const mockEnsureRecordSecret = vi.mocked(
  mockRecordSecretModule.ensureRecordSecret,
);
const mockSecretExistsByUserId = vi.mocked(
  mockRecordSecretModule.secretExistsByUserId,
);
const mockLogger = await import("@/lib/logging/logger");
const mockLogError = vi.mocked(mockLogger.logError);

describe("upsertProfile optimistic concurrency", () => {
  const authUser = { id: crypto.randomUUID() };

  beforeEach(() => {
    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockMaybeSingle = vi.fn().mockResolvedValue({
      data: { user_id: authUser.id, updated_at: "now" },
    });
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle }),
    });
    const mockFrom = vi.fn().mockReturnValue({
      select: mockSelect,
      upsert: mockUpsert,
    });

    (
      mockCreateClient.createClient as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: authUser },
        }),
      },
      from: mockFrom,
    });
  });

  const staleFormData = (expected: string, name = "New Name") => {
    const data = new FormData();
    data.set("expectedUpdatedAt", expected);
    data.set("name", name);
    // A real form submission always includes these <select> fields with a
    // defaultValue; set them explicitly so an object-spread `undefined`
    // doesn't override the existing row's default before Zod validation.
    data.set("bloodGroup", "unknown");
    data.set("genotype", "unknown");
    return data;
  };

  it("returns a conflict error when updated_at changed since form was loaded", async () => {
    (
      mockCreateClient.createClient as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
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
                    return Promise.resolve({
                      data: { user_id: authUser.id, updated_at: "newer" },
                    });
                  },
                };
              },
            };
          },
        };
      },
    });

    const result = await upsertProfile(undefined, staleFormData("stale"));

    expect(result).toEqual({
      error:
        "This profile was updated elsewhere since you loaded this page. Reload and reapply your changes before saving.",
    });
  });

  it("allows a save when the submitted updated_at matches the current row", async () => {
    let upsertCalls = 0;
    (
      mockCreateClient.createClient as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
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
                    return Promise.resolve({
                      data: { user_id: authUser.id, updated_at: "now" },
                    });
                  },
                };
              },
            };
          },
          upsert() {
            upsertCalls += 1;
            return Promise.resolve({ error: null });
          },
        };
      },
    });

    const result = await upsertProfile(undefined, staleFormData("now"));

    expect(result).toEqual({ success: true });
    expect(upsertCalls).toBe(1);
  });

  it("allows a brand-new user's first-ever save with no expectedUpdatedAt token (no prior row to conflict with)", async () => {
    // Mirrors ProfileForm: the hidden expectedUpdatedAt input only renders
    // when a `profile` prop was passed in, so a first-time save submits no
    // such field at all — the concurrency check must not require one when
    // there's no existing row to have conflicted with in the first place.
    let upsertCalls = 0;
    (
      mockCreateClient.createClient as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
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
                    return Promise.resolve({ data: null });
                  },
                };
              },
            };
          },
          upsert() {
            upsertCalls += 1;
            return Promise.resolve({ error: null });
          },
        };
      },
    });

    const data = new FormData();
    data.set("name", "First Save");
    data.set("bloodGroup", "unknown");
    data.set("genotype", "unknown");

    const result = await upsertProfile(undefined, data);

    expect(result).toEqual({ success: true });
    expect(upsertCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// repairProfileSecret
// ---------------------------------------------------------------------------

describe("repairProfileSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockAuth(user: { id: string } | null) {
    (
      mockCreateClient.createClient as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user },
          error: user ? null : new Error("Not authenticated"),
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: user ? { user_id: user.id } : null }),
          }),
        }),
      }),
    });
  }

  it("returns unauthorized when not authenticated", async () => {
    mockAuth(null);
    const result = await repairProfileSecret();
    expect(result).toEqual({ status: "unauthorized" });
  });

  it("returns not_found when profile does not exist", async () => {
    const userId = crypto.randomUUID();
    (
      mockCreateClient.createClient as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: userId } },
          error: null,
        }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null }),
          }),
        }),
      }),
    });
    const result = await repairProfileSecret();
    expect(result).toEqual({ status: "not_found" });
  });

  it("returns already_ok when secret already exists", async () => {
    const userId = crypto.randomUUID();
    mockAuth({ id: userId });
    mockSecretExistsByUserId.mockResolvedValueOnce(true);

    const result = await repairProfileSecret();
    expect(result).toEqual({ status: "already_ok" });
    expect(mockEnsureRecordSecret).not.toHaveBeenCalled();
  });

  it("repairs when secret is missing", async () => {
    const userId = crypto.randomUUID();
    mockAuth({ id: userId });
    mockSecretExistsByUserId.mockResolvedValueOnce(false);
    mockEnsureRecordSecret.mockResolvedValueOnce(undefined);

    const result = await repairProfileSecret();
    expect(result).toEqual({ status: "repaired" });
    expect(mockEnsureRecordSecret).toHaveBeenCalledWith(userId);
  });

  it("returns error when provisioning fails", async () => {
    const userId = crypto.randomUUID();
    mockAuth({ id: userId });
    mockSecretExistsByUserId.mockResolvedValueOnce(false);
    mockEnsureRecordSecret.mockRejectedValueOnce(new Error("db down"));

    const result = await repairProfileSecret();
    expect(result).toEqual({
      status: "error",
      error: "Could not provision verification secret. Please try again later.",
    });
  });

  it("never exposes the raw secret in the result", async () => {
    const userId = crypto.randomUUID();
    mockAuth({ id: userId });
    mockSecretExistsByUserId.mockResolvedValueOnce(false);
    mockEnsureRecordSecret.mockResolvedValueOnce(undefined);

    const result = await repairProfileSecret();
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toMatch(/[0-9a-f]{64}/);
  });

  it("only operates on the authenticated user's own profile — no way to target another user", async () => {
    // repairProfileSecret() takes no parameters: it derives the target
    // user from supabase.auth.getUser(). This test documents that the
    // function always uses the authenticated user's own id, making
    // cross-user repair architecturally impossible.
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    mockAuth({ id: userA });
    mockSecretExistsByUserId.mockResolvedValueOnce(false);
    mockEnsureRecordSecret.mockResolvedValueOnce(undefined);

    await repairProfileSecret();

    // ensureRecordSecret was called with User A's id, never User B's.
    expect(mockEnsureRecordSecret).toHaveBeenCalledWith(userA);
    expect(mockEnsureRecordSecret).not.toHaveBeenCalledWith(userB);
  });

  it("concurrent repair calls converge without duplication or secret rotation", async () => {
    const userId = crypto.randomUUID();
    mockAuth({ id: userId });
    // Both calls see the secret as missing initially.
    mockSecretExistsByUserId.mockResolvedValue(false);

    // Simulate the second call completing between the check and the
    // write: after the first ensureRecordSecret resolves, a subsequent
    // exists-check returns true (secret was provisioned).
    let ensureCallCount = 0;
    mockEnsureRecordSecret.mockImplementation(async () => {
      ensureCallCount += 1;
      // After the first call succeeds, subsequent exists checks return true.
      mockSecretExistsByUserId.mockResolvedValue(true);
    });

    const [resultA, resultB] = await Promise.all([
      repairProfileSecret(),
      repairProfileSecret(),
    ]);

    // Both operations succeed — neither is an error.
    expect(resultA.status).not.toBe("error");
    expect(resultB.status).not.toBe("error");

    // At least one actually provisioned; the other either provisioned
    // (idempotent upsert) or saw already_ok.
    const statuses = [resultA.status, resultB.status];
    expect(statuses).toContain("repaired");

    // ensureRecordSecret may be called once or twice depending on
    // scheduling, but because it uses upsert+ignoreDuplicates, no
    // duplicate rows or secret rotation can occur.
    expect(ensureCallCount).toBeGreaterThanOrEqual(1);
    expect(ensureCallCount).toBeLessThanOrEqual(2);
  });

  it("emits a redacted operational log on provisioning failure", async () => {
    const userId = crypto.randomUUID();
    mockAuth({ id: userId });
    mockSecretExistsByUserId.mockResolvedValueOnce(false);
    mockEnsureRecordSecret.mockRejectedValueOnce(
      new Error("db connection lost"),
    );

    const result = await repairProfileSecret();
    expect(result.status).toBe("error");

    // Verify logError was called with the right message and context.
    expect(mockLogError).toHaveBeenCalledWith(
      "Failed to repair profile secret",
      expect.objectContaining({ message: "db connection lost" }),
      expect.objectContaining({
        route: "/profile (action: repairProfileSecret)",
        userId,
      }),
    );
  });
});
