/**
 * Tests for app/(auth)/profile/delete-account-button.tsx — the multi-step
 * account deletion confirmation UI.
 *
 * Covers issue #330: proves that a single click alone does NOT trigger
 * deletion, confirming requires an explicit step (typing DELETE into the
 * confirmation input and submitting), and cancelling leaves the account
 * untouched.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the server action *before* importing the component so that the
// useActionState binding picks up the mock.
// ---------------------------------------------------------------------------
const mockDeleteAccount = vi.fn();

vi.mock("./actions", () => ({
  deleteAccount: (...args: unknown[]) => mockDeleteAccount(...args),
}));

// useActionState is the React 19 hook used by the component. Vitest's jsdom
// environment ships a real React, so we don't need to stub it — but we do
// need to make the mock action accessible as the bound form action.
// The hook binds the async action via `formAction`; submitting the <form>
// calls formAction(formData). We spy on the module export rather than the
// hook so any call to the underlying action is detected.

import { DeleteAccountButton } from "./delete-account-button";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderButton() {
  render(<DeleteAccountButton />);
}

async function openConfirmStep() {
  await userEvent.click(
    screen.getByRole("button", { name: /delete account/i }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeleteAccountButton", () => {
  beforeEach(() => {
    mockDeleteAccount.mockReset();
    // Default: action resolves without error
    mockDeleteAccount.mockResolvedValue(undefined);
  });

  // ── Idle state ────────────────────────────────────────────────────────────

  it("renders a 'Delete account' button in the idle state", () => {
    renderButton();
    expect(
      screen.getByRole("button", { name: /delete account/i }),
    ).toBeInTheDocument();
  });

  it("does NOT show the confirmation form in the idle state", () => {
    renderButton();
    // The confirm input should not exist until the user clicks the button.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /permanently delete/i })).toBeNull();
  });

  // ── Clicking idle button alone must NOT call the action ──────────────────

  it("clicking the idle 'Delete account' button alone does NOT call the delete action", async () => {
    renderButton();
    await openConfirmStep();
    // Just clicking the initial button — no form submission — must never
    // invoke the deletion action.
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  // ── Confirm step UI ───────────────────────────────────────────────────────

  it("shows the confirmation form after clicking 'Delete account'", async () => {
    renderButton();
    await openConfirmStep();

    // Confirmation text input
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // Submit button
    expect(
      screen.getByRole("button", { name: /permanently delete/i }),
    ).toBeInTheDocument();
    // Cancel button
    expect(
      screen.getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
  });

  it("shows a warning about permanent deletion in the confirm step", async () => {
    renderButton();
    await openConfirmStep();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  // ── Cancelling must NOT call the action ───────────────────────────────────

  it("clicking Cancel returns to the idle state without calling the delete action", async () => {
    renderButton();
    await openConfirmStep();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockDeleteAccount).not.toHaveBeenCalled();
    // Back to idle: confirm form is gone, original button is restored.
    expect(
      screen.getByRole("button", { name: /delete account/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  // ── Submitting without the correct confirmation word ──────────────────────

  it("does NOT call the delete action when the confirm field is empty and the form is submitted", async () => {
    renderButton();
    await openConfirmStep();

    // Leave the confirm input empty — required="" on the input prevents
    // native submission; the action is never called.
    await userEvent.click(
      screen.getByRole("button", { name: /permanently delete/i }),
    );

    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  // ── Successful confirmation calls the action exactly once ─────────────────

  it("typing DELETE and submitting calls the delete action exactly once", async () => {
    renderButton();
    await openConfirmStep();

    await userEvent.type(screen.getByRole("textbox"), "DELETE");
    await userEvent.click(
      screen.getByRole("button", { name: /permanently delete/i }),
    );

    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("does NOT call the delete action a second time on double-submit (no double-submit bug)", async () => {
    // Simulate a user clicking the submit button quickly twice.
    renderButton();
    await openConfirmStep();

    await userEvent.type(screen.getByRole("textbox"), "DELETE");

    const submitBtn = screen.getByRole("button", { name: /permanently delete/i });
    // Click twice in rapid succession.
    await userEvent.dblClick(submitBtn);

    // The action must have been called at most once — the button is
    // disabled while isPending is true, preventing a double submission.
    expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
  });
});
