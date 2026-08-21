import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertProfile } from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/attestation/recordSecret", () => ({
  ensureRecordSecret: vi.fn().mockResolvedValue("c".repeat(64)),
  getSecretByUserId: vi.fn(),
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
