import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  repairProfileSecret: vi.fn(),
}));

import { repairProfileSecret } from "./actions";

import { MissingSecretBanner } from "./missing-secret-banner";

const mockRepair = vi.mocked(repairProfileSecret);

describe("MissingSecretBanner", () => {
  it("renders the warning message and repair button in initial state", async () => {
    mockRepair.mockResolvedValue({ status: "repaired" });
    render(<MissingSecretBanner />);

    expect(
      screen.getByText("Verification setup needs repair"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your profile is saved but the verification secret/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /repair verification setup/i }),
    ).toBeInTheDocument();
  });

  it("displays error message when repair fails", async () => {
    mockRepair.mockResolvedValue({
      status: "error",
      error: "Could not provision verification secret. Please try again later.",
    });

    render(<MissingSecretBanner />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /repair verification setup/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not provision verification secret. Please try again later.",
    );
  });

  it("shows success state after repair succeeds", async () => {
    mockRepair.mockResolvedValue({ status: "repaired" });

    render(<MissingSecretBanner />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /repair verification setup/i }),
    );

    expect(
      await screen.findByRole("button", { name: /verification repaired/i }),
    ).toBeDisabled();
  });

  it("shows success state when secret already existed (idempotent)", async () => {
    mockRepair.mockResolvedValue({ status: "already_ok" });

    render(<MissingSecretBanner />);

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /repair verification setup/i }),
    );

    expect(
      await screen.findByRole("button", { name: /verification repaired/i }),
    ).toBeDisabled();
  });
});
