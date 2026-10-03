import { afterEach, describe, expect, it, vi } from "vitest";

const { mockGetUser, mockLogError } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));
vi.mock("@/lib/logging/logger", () => ({
  logError: mockLogError,
}));

import { POST } from "./route";

const AUTHED_USER = { data: { user: { id: "user-1" } }, error: null };
const VALID_CAPABILITY_URL =
  "https://lafiya.example/card/c/lafiya_e1_" + "a".repeat(43);

function jsonRequest(body: unknown) {
  return new Request("https://lafiya.example/api/wallet/google", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/wallet/google", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when the caller is unauthenticated", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await POST(jsonRequest({ capabilityUrl: VALID_CAPABILITY_URL }));

    expect(response.status).toBe(401);
  });

  it("returns 400 when capabilityUrl is missing", async () => {
    mockGetUser.mockResolvedValue(AUTHED_USER);

    const response = await POST(jsonRequest({}));

    expect(response.status).toBe(400);
  });

  it("returns 400 for a non-capability URL (e.g. the permanent /card/[id] link)", async () => {
    mockGetUser.mockResolvedValue(AUTHED_USER);

    const response = await POST(
      jsonRequest({
        capabilityUrl: "https://lafiya.example/card/11111111-1111-1111-1111-111111111111",
      }),
    );

    expect(response.status).toBe(400);
  });

  /**
   * The core contract for issue #538: with no Google Wallet service-account
   * credentials in the environment, this route must fail clearly (501)
   * rather than ever emit a fake/unsigned save link. This test runs in CI,
   * where the credential env vars are never set.
   */
  it("returns 501 with a clear message when Google Wallet signing is not configured", async () => {
    mockGetUser.mockResolvedValue(AUTHED_USER);

    const response = await POST(jsonRequest({ capabilityUrl: VALID_CAPABILITY_URL }));
    const payload = await response.json();

    expect(response.status).toBe(501);
    expect(payload.error).toMatch(/not configured|not yet available/i);
  });
});
