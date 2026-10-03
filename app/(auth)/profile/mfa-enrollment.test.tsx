import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockListFactors,
  mockEnroll,
  mockUnenroll,
  mockChallengeAndVerify,
} = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  mockEnroll: vi.fn(),
  mockUnenroll: vi.fn(),
  mockChallengeAndVerify: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: mockListFactors,
        enroll: mockEnroll,
        unenroll: mockUnenroll,
        challengeAndVerify: mockChallengeAndVerify,
      },
    },
  }),
}));

import { MfaEnrollment } from "./mfa-enrollment";

const VERIFIED_FACTOR = { id: "factor-1", status: "verified" };
const ENROLL_RESPONSE = {
  data: {
    id: "factor-new",
    type: "totp",
    totp: {
      qr_code: "data:image/svg+xml;utf8,<svg></svg>",
      secret: "ABCD1234",
      uri: "otpauth://totp/example",
    },
  },
  error: null,
};

describe("MfaEnrollment (#522)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnenroll.mockResolvedValue({ data: {}, error: null });
  });

  it("offers to set up MFA when no verified factor is enrolled", async () => {
    mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    render(<MfaEnrollment />);

    expect(
      await screen.findByText(/two-factor authentication is off/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set up/i })).toBeInTheDocument();
  });

  it("shows the enrolled state with a Turn off control when a verified factor exists", async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });
    render(<MfaEnrollment />);

    expect(
      await screen.findByText(/two-factor authentication is on/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /turn off/i }),
    ).toBeInTheDocument();
  });

  it("starts enrollment, shows the QR code and secret, then verifies and enables MFA", async () => {
    mockListFactors
      .mockResolvedValueOnce({ data: { totp: [] }, error: null })
      .mockResolvedValueOnce({
        data: { totp: [{ id: "factor-new", status: "verified" }] },
        error: null,
      });
    mockEnroll.mockResolvedValue(ENROLL_RESPONSE);
    mockChallengeAndVerify.mockResolvedValue({ data: {}, error: null });

    const user = userEvent.setup();
    render(<MfaEnrollment />);

    await user.click(await screen.findByRole("button", { name: /set up/i }));

    expect(
      await screen.findByAltText(/two-factor authentication qr code/i),
    ).toHaveAttribute("src", ENROLL_RESPONSE.data.totp.qr_code);
    expect(screen.getByText(ENROLL_RESPONSE.data.totp.secret)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/enter the 6-digit code/i),
      "654321",
    );
    await user.click(
      screen.getByRole("button", { name: /verify and enable/i }),
    );

    expect(mockChallengeAndVerify).toHaveBeenCalledWith({
      factorId: "factor-new",
      code: "654321",
    });
    expect(
      await screen.findByText(/two-factor authentication is on/i),
    ).toBeInTheDocument();
  });

  it("removes the unverified factor when enrollment is cancelled", async () => {
    mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    mockEnroll.mockResolvedValue(ENROLL_RESPONSE);

    const user = userEvent.setup();
    render(<MfaEnrollment />);

    await user.click(await screen.findByRole("button", { name: /set up/i }));
    await screen.findByAltText(/two-factor authentication qr code/i);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockUnenroll).toHaveBeenCalledWith({ factorId: "factor-new" });
    expect(
      await screen.findByText(/two-factor authentication is off/i),
    ).toBeInTheDocument();
  });

  it("requires a confirm step before turning MFA off, and calls unenroll only after confirming", async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });

    const user = userEvent.setup();
    render(<MfaEnrollment />);

    await user.click(await screen.findByRole("button", { name: /turn off/i }));
    expect(mockUnenroll).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByRole("button", { name: /turn off/i });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(mockUnenroll).toHaveBeenCalledWith({
      factorId: VERIFIED_FACTOR.id,
    });
  });
});
