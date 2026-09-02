/**
 * Tests for app/(auth)/profile/acknowledge-consent-button.tsx
 *
 * Covers issue #331: verifies both visual states (idle vs. already-done),
 * confirms the server action is invoked on click (not just a local state
 * update), and that the button is not re-clickable once acknowledged.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the server action before importing the component.
// ---------------------------------------------------------------------------
const mockAcknowledgeCurrentPolicy = vi.fn();

vi.mock("./consent/actions", () => ({
  acknowledgeCurrentPolicy: (...args: unknown[]) =>
    mockAcknowledgeCurrentPolicy(...args),
}));

import { AcknowledgeConsentButton } from "./acknowledge-consent-button";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AcknowledgeConsentButton", () => {
  beforeEach(() => {
    mockAcknowledgeCurrentPolicy.mockReset();
  });

  // ── Idle (unacknowledged) state ───────────────────────────────────────────

  it("renders an enabled button in the idle state", () => {
    render(<AcknowledgeConsentButton />);

    const button = screen.getByRole("button", {
      name: /acknowledge current policy/i,
    });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it("does NOT show a success message before the button is clicked", () => {
    render(<AcknowledgeConsentButton />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  // ── Server action is called on click ─────────────────────────────────────

  it("calls the server action exactly once when clicked", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "acknowledged",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    expect(mockAcknowledgeCurrentPolicy).toHaveBeenCalledTimes(1);
  });

  it("does NOT merely update local state — it dispatches to the server action", async () => {
    // This test ensures the server action mock is actually invoked (i.e. the
    // component doesn't just flip a local boolean without calling the action).
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "acknowledged",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    await waitFor(() =>
      expect(mockAcknowledgeCurrentPolicy).toHaveBeenCalledTimes(1),
    );
  });

  // ── Already-acknowledged state ────────────────────────────────────────────

  it("disables the button after a successful acknowledgement", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "acknowledged",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    // Wait for the async transition to resolve.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /acknowledged/i }),
      ).toBeDisabled(),
    );
  });

  it("does NOT call the server action a second time after it is already acknowledged", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "acknowledged",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /acknowledged/i }),
      ).toBeDisabled(),
    );

    // Attempt to click the now-disabled button — must not fire again.
    await userEvent.click(screen.getByRole("button", { name: /acknowledged/i }));

    expect(mockAcknowledgeCurrentPolicy).toHaveBeenCalledTimes(1);
  });

  it("shows a confirmation message after acknowledgement", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "acknowledged",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toBeInTheDocument(),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /acknowledgement has been recorded/i,
    );
  });

  // ── already_acknowledged response ─────────────────────────────────────────

  it("shows an 'already acknowledged' message when the server says so", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "already_acknowledged",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /already acknowledged/i,
      ),
    );
  });

  // ── Error state ───────────────────────────────────────────────────────────

  it("shows an error message when the server action fails", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({
      status: "error",
      error: "Database unavailable",
    });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /database unavailable/i,
      ),
    );

    // The button is not permanently disabled on error — the user can retry.
    expect(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    ).not.toBeDisabled();
  });

  it("falls back to a generic error message when no error string is provided", async () => {
    mockAcknowledgeCurrentPolicy.mockResolvedValue({ status: "error" });

    render(<AcknowledgeConsentButton />);
    await userEvent.click(
      screen.getByRole("button", { name: /acknowledge current policy/i }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /something went wrong/i,
      ),
    );
  });
});
