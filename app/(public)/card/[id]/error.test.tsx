/**
 * Tests for app/(public)/card/[id]/error.tsx — the Next.js error boundary
 * for the emergency card page.
 *
 * Covers issue #329: verifies the fallback renders reassuring, actionable
 * content for a responder in an emergency rather than a blank screen or a
 * raw stack trace, and that the reset/retry action is present and callable.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CardError from "./error";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function buildError(message: string): Error & { digest?: string } {
  return Object.assign(new Error(message), { digest: undefined });
}

// ---------------------------------------------------------------------------
// Tests: UNAVAILABLE path
// ---------------------------------------------------------------------------

describe("CardError — UNAVAILABLE error", () => {
  it("renders without crashing", () => {
    const reset = vi.fn();
    render(<CardError error={buildError("UNAVAILABLE")} reset={reset} />);
  });

  it("does NOT render the raw error message to the page", () => {
    const reset = vi.fn();
    render(<CardError error={buildError("UNAVAILABLE")} reset={reset} />);
    // The literal sentinel string must not appear in visible content.
    expect(screen.queryByText("UNAVAILABLE")).toBeNull();
  });

  it("shows a specific, reassuring message — not a generic 'Something went wrong'", () => {
    const reset = vi.fn();
    render(<CardError error={buildError("UNAVAILABLE")} reset={reset} />);

    // The component renders "This emergency card is temporarily unavailable."
    expect(
      screen.getByText(/this emergency card is temporarily unavailable/i),
    ).toBeInTheDocument();

    // Should also offer guidance to the responder.
    expect(
      screen.getByText(/please try again/i),
    ).toBeInTheDocument();
  });

  it("does NOT show a generic 'Something went wrong' message", () => {
    const reset = vi.fn();
    render(<CardError error={buildError("UNAVAILABLE")} reset={reset} />);
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it("renders a Retry button", () => {
    const reset = vi.fn();
    render(<CardError error={buildError("UNAVAILABLE")} reset={reset} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls the reset function when the Retry button is clicked", async () => {
    const reset = vi.fn();
    render(<CardError error={buildError("UNAVAILABLE")} reset={reset} />);

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("does not render any stack trace text", () => {
    const error = buildError("UNAVAILABLE");
    error.stack = "Error: UNAVAILABLE\n    at CardPage (card/[id]/page.tsx:42)";
    const reset = vi.fn();
    render(<CardError error={error} reset={reset} />);

    // Stack trace lines typically start with whitespace + "at ".
    expect(screen.queryByText(/at CardPage/)).toBeNull();
    expect(screen.queryByText(/page\.tsx/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: non-UNAVAILABLE (re-throw) path
// ---------------------------------------------------------------------------

describe("CardError — non-UNAVAILABLE error", () => {
  it("re-throws the error rather than swallowing it", () => {
    const reset = vi.fn();
    const thrownError = buildError("SOME_OTHER_ERROR");

    // CardError re-throws for unrecognised messages; wrapping in a
    // try/catch lets us assert without crashing the test runner.
    expect(() =>
      render(<CardError error={thrownError} reset={reset} />),
    ).toThrow(thrownError);
  });
});
