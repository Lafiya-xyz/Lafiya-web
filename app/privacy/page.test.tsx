import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These pages are linked from the sign-up flow before an account exists, so
// they must render with zero session/auth context. This guards against a
// hook or helper that silently assumes a logged-in user creeping in later.

import PrivacyPage from "./page";

describe("PrivacyPage (unauthenticated)", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("renders successfully with no session present", () => {
    render(<PrivacyPage />);

    expect(
      screen.getByRole("heading", { name: "Privacy Policy" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/What we collect/)).toBeInTheDocument();
    expect(screen.getByText(/Row-Level Security/)).toBeInTheDocument();
  });

  it("logs no console errors or warnings related to missing auth context", () => {
    render(<PrivacyPage />);

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
