import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConsentHistory } from "./consent-history";

vi.mock("./consent-acknowledgement-form", () => ({
  ConsentAcknowledgementForm: () => <button>Acknowledge current policy</button>,
}));

describe("ConsentHistory", () => {
  it("renders policy versions and acceptance timestamps", () => {
    render(
      <ConsentHistory
        logs={[
          {
            id: "consent-1",
            user_id: "user-123",
            policy_version: "ndpa-2023-v1",
            accepted_at: "2026-08-19T10:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText("ndpa-2023-v1")).toBeInTheDocument();
    expect(screen.getByText(/Aug 19, 2026/)).toBeInTheDocument();
    expect(screen.getByText("Current policy acknowledged.")).toBeInTheDocument();
  });

  it("offers acknowledgement when the current policy is missing", () => {
    render(<ConsentHistory logs={[]} />);

    expect(
      screen.getByText("No consent acknowledgements recorded yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Acknowledge current policy" }),
    ).toBeInTheDocument();
  });
});
