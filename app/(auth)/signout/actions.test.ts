import { beforeEach, describe, expect, it, vi } from "vitest";
import { signOut } from "./actions";
import { redirect } from "next/navigation";

// Mock functions hoisted before module imports are processed
const { mockSignOut } = vi.hoisted(() => ({
  mockSignOut: vi.fn(),
}));

// Mock Supabase Server Client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn().mockImplementation(() => ({
    auth: {
      signOut: mockSignOut,
    },
  })),
}));

// Mock Next.js Navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

describe("signOut server action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("signs out user with active session and redirects to home", async () => {
    // Simulate successful sign-out with active session
    mockSignOut.mockResolvedValue({ error: null });

    await signOut();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/");
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("handles sign-out when there is no active session without throwing", async () => {
    // Simulate sign-out when no session exists (Supabase returns success anyway)
    mockSignOut.mockResolvedValue({ error: null });

    // Should not throw
    await expect(signOut()).resolves.toBeUndefined();

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("redirects even if Supabase returns no error on sign-out", async () => {
    // Supabase signOut can be called on a client with no session,
    // and it still returns { error: null } — the sign-out action should
    // still redirect in that case rather than throwing
    mockSignOut.mockResolvedValue({ error: null });

    await signOut();

    expect(redirect).toHaveBeenCalledWith("/");
  });

  it("allows multiple sequential sign-out calls without state corruption", async () => {
    mockSignOut.mockResolvedValue({ error: null });

    // Simulate rapid successive sign-out calls (e.g., double-click scenario)
    await signOut();
    await signOut();

    expect(mockSignOut).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenNthCalledWith(1, "/");
    expect(redirect).toHaveBeenNthCalledWith(2, "/");
  });

  it("does not mask Supabase errors from being thrown", async () => {
    const authError = new Error("Supabase connection failed");
    mockSignOut.mockRejectedValue(authError);

    await expect(signOut()).rejects.toThrow("Supabase connection failed");

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // redirect should not be called if signOut throws
    expect(redirect).not.toHaveBeenCalled();
  });
});
