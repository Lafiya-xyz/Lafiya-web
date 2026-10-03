import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: mocks.getUser,
      getSession: mocks.getSession,
      signOut: mocks.signOut,
    },
    rpc: mocks.rpc,
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logging/logger", () => ({ logError: vi.fn() }));

import { revalidatePath } from "next/cache";

import { revokeOtherSessions, revokeSession } from "./sessions-actions";

const CURRENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function accessToken(sessionId: string) {
  const payload = Buffer.from(
    JSON.stringify({ session_id: sessionId }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function form(sessionId: unknown) {
  const formData = new FormData();
  if (typeof sessionId === "string") formData.set("sessionId", sessionId);
  return formData;
}

beforeEach(() => {
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  mocks.getSession.mockResolvedValue({
    data: { session: { access_token: accessToken(CURRENT) } },
  });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("revokeSession (#523)", () => {
  it("revokes another of the caller's sessions through revoke_my_session", async () => {
    const result = await revokeSession(undefined, form(OTHER));

    expect(mocks.rpc).toHaveBeenCalledWith("revoke_my_session", {
      p_session_id: OTHER,
    });
    expect(result).toEqual({ info: "That device has been signed out." });
    expect(revalidatePath).toHaveBeenCalledWith("/profile");
  });

  it("reports a session that was already gone", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect(await revokeSession(undefined, form(OTHER))).toEqual({
      info: "That device was already signed out.",
    });
  });

  it.each([[undefined], [""], ["not-a-uuid"], ["1; drop table x"]])(
    "rejects a malformed session id %j without calling the database",
    async (value) => {
      const result = await revokeSession(undefined, form(value));
      expect(result.error).toBeDefined();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("refuses to revoke the current session (that is what Sign out is for)", async () => {
    const result = await revokeSession(undefined, form(CURRENT));
    expect(result.error).toContain("Sign out");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const result = await revokeSession(undefined, form(OTHER));
    expect(result.error).toBeDefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns a friendly error when the database call fails", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("boom") });
    const result = await revokeSession(undefined, form(OTHER));
    expect(result.error).toBe(
      "We couldn't sign out that device. Please try again.",
    );
  });
});

describe("revokeOtherSessions (#523)", () => {
  it("signs out every other session and keeps this one", async () => {
    const result = await revokeOtherSessions();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "others" });
    expect(result).toEqual({ info: "All other devices have been signed out." });
  });

  it("requires a signed-in user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const result = await revokeOtherSessions();
    expect(result.error).toBeDefined();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("surfaces a failure", async () => {
    mocks.signOut.mockResolvedValue({ error: new Error("boom") });
    expect((await revokeOtherSessions()).error).toBeDefined();
  });
});
