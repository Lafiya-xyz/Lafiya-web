import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListFactors, mockChallengeAndVerify } = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  mockChallengeAndVerify: vi.fn(),
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

import { StepUpChallenge } from "./step-up-challenge";

const VERIFIED_FACTOR = { id: "factor-1", status: "verified" };

function setup(props?: Partial<Parameters<typeof StepUpChallenge>[0]>) {
  const onVerified = vi.fn();
  const onCancel = vi.fn();
  const user = userEvent.setup();

  render(<StepUpChallenge onVerified={onVerified} onCancel={onCancel} {...props} />);

  const dialog = screen.getByRole("dialog", { hidden: true });
  return { user, onVerified, onCancel, dialog };
}

describe("StepUpChallenge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({
      data: { totp: [VERIFIED_FACTOR] },
      error: null,
    });
    mockChallengeAndVerify.mockResolvedValue({ data: {}, error: null });

    // jsdom does not implement native <dialog> modal behaviour -- the
    // component calls showModal() on mount (a real useEffect, which runs
    // before any post-render per-instance patch could apply), so this has
    // to be polyfilled at the prototype level before rendering.
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
  });

  it("shows the code input and disables Verify until 6 digits are entered", () => {
    setup();
    expect(
      screen.getByRole("button", { name: /^verify$/i }),
    ).toBeDisabled();
  });

  it("calls challengeAndVerify with the enrolled factor and code, then onVerified — without also firing onCancel", async () => {
    const { user, onVerified, onCancel } = setup();

    await user.type(screen.getByLabelText(/authentication code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    await waitFor(() =>
      expect(mockChallengeAndVerify).toHaveBeenCalledWith({
        factorId: VERIFIED_FACTOR.id,
        code: "123456",
      }),
    );
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows an error and does not call onVerified when the code is rejected", async () => {
    mockChallengeAndVerify.mockResolvedValue({
      data: null,
      error: new Error("invalid code"),
    });
    const { user, onVerified } = setup();

    await user.type(screen.getByLabelText(/authentication code/i), "000000");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/didn't work/i);
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("shows an error when no verified TOTP factor is enrolled", async () => {
    mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    const { user, onVerified } = setup();

    await user.type(screen.getByLabelText(/authentication code/i), "123456");
    await user.click(screen.getByRole("button", { name: /^verify$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no verified authenticator/i,
    );
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("calls onCancel (and never onVerified) when Cancel is clicked", async () => {
    const { user, onVerified, onCancel } = setup();

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
    expect(mockChallengeAndVerify).not.toHaveBeenCalled();
  });
});
