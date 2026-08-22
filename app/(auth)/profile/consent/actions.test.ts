import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Supabase server client. We control getUser() and from() per test
// so we can assert the action only ever operates on the authenticated user.
const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));
vi.mock("@/lib/logging/logger", () => ({ logError: vi.fn() }));

import { getConsentHistory, acknowledgeCurrentPolicy } from "./actions";

const USER_A = { id: "user-a", email: "a@example.com" };
const USER_B = { id: "user-b", email: "b@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getConsentHistory", () => {
  it("returns the signed-in user's own consent rows", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER_A }, error: null });

    const rows = [
      { policy_version: "ndpa-2023-v1", accepted_at: "2024-01-01T00:00:00Z" },
    ];
    const eqSpy = vi.fn(() => ({
      order: vi.fn(() => ({ data: rows, error: null })),
    }));
    mockFrom.mockReturnValue({ select: vi.fn(() => ({ eq: eqSpy })) });

    const result = await getConsentHistory();

    expect(result).toHaveLength(1);
    expect(result[0].policyVersion).toBe("ndpa-2023-v1");
    expect(result[0].acceptedAt).toBe("2024-01-01T00:00:00Z");
    // The SQL is always scoped to the authenticated user, never another id.
    expect(mockFrom).toHaveBeenCalledWith("consent_logs");
    expect(eqSpy).toHaveBeenCalledWith("user_id", "user-a");
  });

  it("scopes the query to whichever user is authenticated (cross-user isolation at app layer)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER_B }, error: null });
    const eqSpy = vi.fn(() => ({
      order: vi.fn(() => ({ data: [], error: null })),
    }));
    mockFrom.mockReturnValue({ select: vi.fn(() => ({ eq: eqSpy })) });

    await getConsentHistory();

    expect(eqSpy).toHaveBeenCalledWith("user_id", "user-b");
  });

  it("returns an empty list when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const result = await getConsentHistory();
    expect(result).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("returns an empty list (never another user's data) on read error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER_A }, error: null });
    const eqSpy = vi.fn(() => ({
      order: vi.fn(() => ({
        data: null,
        error: { message: "boom", code: "P0001" },
      })),
    }));
    mockFrom.mockReturnValue({ select: vi.fn(() => ({ eq: eqSpy })) });

    const result = await getConsentHistory();
    expect(result).toEqual([]);
  });
});

describe("acknowledgeCurrentPolicy", () => {
  it("records acknowledgement for the authenticated user's current version", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER_A }, error: null });
    const insertSpy = vi.fn(() => ({ error: null }));
    mockFrom.mockReturnValue({ insert: insertSpy });

    const result = await acknowledgeCurrentPolicy();

    expect(result.status).toBe("acknowledged");
    expect(insertSpy).toHaveBeenCalledWith({
      user_id: "user-a",
      policy_version: "ndpa-2023-v1",
    });
  });

  it("treats a duplicate (unique-constraint) acknowledgement as idempotent success", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER_A }, error: null });
    const insertSpy = vi.fn(() => ({
      error: { code: "23505", message: "duplicate key" },
    }));
    mockFrom.mockReturnValue({ insert: insertSpy });

    const result = await acknowledgeCurrentPolicy();
    expect(result.status).toBe("already_acknowledged");
  });

  it("reports a non-unique insert error", async () => {
    mockGetUser.mockResolvedValue({ data: { user: USER_A }, error: null });
    const insertSpy = vi.fn(() => ({
      error: { code: "42501", message: "permission denied" },
    }));
    mockFrom.mockReturnValue({ insert: insertSpy });

    const result = await acknowledgeCurrentPolicy();
    expect(result.status).toBe("error");
    expect(result.error).toBe("permission denied");
  });

  it("refuses when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const result = await acknowledgeCurrentPolicy();
    expect(result.status).toBe("error");
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
