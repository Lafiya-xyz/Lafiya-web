import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockReplace, mockListFactors, mockChallengeAndVerify } = vi.hoisted(
  () => ({
    mockReplace: vi.fn(),
    mockListFactors: vi.fn(),
    mockChallengeAndVerify: vi.fn(),
  }),
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: mockListFactors,
        challengeAndVerify: mockChallengeAndVerify,
      },
    },
  }),
}));

import { VerifyStepUpClient } from "./verify-step-up-client";

describe("VerifyStepUpClient (#522)", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: "factor-1", status: "verified" }] },
      error: null,
    });
    mockChallengeAndVerify.mockResolvedValue({ data: {}, error: null });

    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });

    // @ts-expect-error -- stubbing window.location for a jsdom navigation
    // assertion; only `.href` is read/written by the component.
    delete window.location;
    // @ts-expect-error -- see above
    window.location = { href: "" };
  });

  afterEach(() => {
    // @ts-expect-error -- restoring the real Location object stubbed above
    window.location = originalLocation;
  });

  it("opens the challenge immediately", () => {
    render(<VerifyStepUpClient next="/profile/export" />);
    expect(screen.getByRole("dialog", { hidden: true })).toHaveAttribute(
      "open",
    );
  });

  it("navigates to `next` via a full page load once verified", async () => {
    const user = userEvent.setup();
    render(<VerifyStepUpClient next="/profile/export" />);

    await user.type(screen.getByLabelText(/authentication code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await vi.waitUntil(() => window.location.href === "/profile/export");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects to /profile when the challenge is cancelled", async () => {
    const user = userEvent.setup();
    render(<VerifyStepUpClient next="/profile/export" />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockReplace).toHaveBeenCalledWith("/profile");
    expect(window.location.href).toBe("");
  });
});
