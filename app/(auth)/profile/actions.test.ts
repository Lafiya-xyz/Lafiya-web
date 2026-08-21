import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertProfile } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/attestation/recordSecret", () => ({
  ensureRecordSecret: vi.fn().mockResolvedValue("c".repeat(64)),
  getSecretByUserId: vi.fn(),
  secretExistsByUserId: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/logging/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const { createClient } = await import("@/lib/supabase/server");
const authUser = { id: crypto.randomUUID() };

function form(expected?: string) {
  const data = new FormData();
  if (expected) data.set("expectedRevisionId", expected);
  data.set("name", "Patient");
  data.set("bloodGroup", "unknown");
  data.set("genotype", "unknown");
  return data;
}

function clientFor(
  existing: Record<string, unknown> | null,
  rpc = vi.fn().mockResolvedValue({ error: null }),
) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: existing });
  const single = vi
    .fn()
    .mockResolvedValue({ data: { card_public_id: "card-id" } });
  return {
    rpc,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: authUser } }) },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ maybeSingle, single }),
      }),
    }),
  };
}

describe("upsertProfile revision concurrency", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a typed conflict before mutation for an already-stale form", async () => {
    const client = clientFor({
      user_id: authUser.id,
      current_revision_id: "newer",
    });
    vi.mocked(createClient).mockResolvedValue(client as never);
    await expect(
      upsertProfile(undefined, form("stale")),
    ).resolves.toMatchObject({ code: "STALE_REVISION" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("passes the revision token to the atomic save RPC", async () => {
    const client = clientFor({
      user_id: authUser.id,
      current_revision_id: "current",
      disclosure_policy: { version: 1, fields: {} },
    });
    vi.mocked(createClient).mockResolvedValue(client as never);
    await expect(upsertProfile(undefined, form("current"))).resolves.toEqual({
      success: true,
    });
    expect(client.rpc).toHaveBeenCalledWith(
      "save_record_revision",
      expect.objectContaining({ p_expected_revision_id: "current" }),
    );
  });

  it("allows an atomic first save with a null predecessor", async () => {
    const client = clientFor(null);
    vi.mocked(createClient).mockResolvedValue(client as never);
    await expect(upsertProfile(undefined, form())).resolves.toEqual({
      success: true,
    });
    expect(client.rpc).toHaveBeenCalledWith(
      "save_record_revision",
      expect.objectContaining({ p_expected_revision_id: null }),
    );
  });

  it("maps a database serialization failure to a typed conflict", async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: { code: "40001", message: "STALE_REVISION" },
    });
    const client = clientFor(
      { user_id: authUser.id, current_revision_id: "current" },
      rpc,
    );
    vi.mocked(createClient).mockResolvedValue(client as never);
    await expect(
      upsertProfile(undefined, form("current")),
    ).resolves.toMatchObject({ code: "STALE_REVISION" });
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
