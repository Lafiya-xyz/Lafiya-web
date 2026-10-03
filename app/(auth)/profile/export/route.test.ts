import { describe, expect, it, vi } from "vitest";

const { mockExportMyProfileData } = vi.hoisted(() => ({
  mockExportMyProfileData: vi.fn(),
}));

vi.mock("../actions", () => ({
  exportMyProfileData: mockExportMyProfileData,
}));

import { GET } from "./route";

function request() {
  return new Request("http://localhost:3000/profile/export");
}

describe("GET /profile/export (#522)", () => {
  it("returns the export as a downloadable JSON attachment on success", async () => {
    mockExportMyProfileData.mockResolvedValue({
      data: { exportedAt: "2026-01-01T00:00:00Z" },
    });

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("returns 401 for a plain auth error", async () => {
    mockExportMyProfileData.mockResolvedValue({
      error: "You must be signed in to export your data.",
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
  });

  it("redirects to the step-up verification page when STEP_UP_REQUIRED, preserving this URL as next", async () => {
    mockExportMyProfileData.mockResolvedValue({
      error: "Additional verification is required to export your data.",
      code: "STEP_UP_REQUIRED",
    });

    const res = await GET(request());

    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toContain("/profile/verify-step-up");
    expect(location).toContain(encodeURIComponent("/profile/export"));
  });
});
