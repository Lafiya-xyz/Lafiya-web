import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ConsentHistoryView } from "./consent-history";

const baseProps = {
  currentVersion: "ndpa-2023-v1",
  currentLabel: "NDPA (2023)",
  termsRoute: "/terms",
  privacyRoute: "/privacy",
};

describe("ConsentHistoryView", () => {
  it("renders the user's recorded consent rows", () => {
    render(
      <ConsentHistoryView
        {...baseProps}
        history={[
          { policyVersion: "ndpa-2023-v1", acceptedAt: "2024-01-01T00:00:00Z" },
        ]}
        needsAcknowledgement={false}
      />,
    );

    expect(screen.getByText("ndpa-2023-v1")).toBeInTheDocument();
    expect(
      screen.getByText(/You have acknowledged the current policy/i),
    ).toBeInTheDocument();
  });

  it("prompts for acknowledgement and shows the button when the current version is missing", () => {
    render(
      <ConsentHistoryView
        {...baseProps}
        history={[]}
        needsAcknowledgement={true}
      />,
    );

    expect(screen.getByText(/A new privacy policy/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Acknowledge current policy/i }),
    ).toBeInTheDocument();
  });

  it("renders a friendly empty state when no consent exists and none is required", () => {
    render(
      <ConsentHistoryView
        {...baseProps}
        history={[]}
        needsAcknowledgement={false}
      />,
    );
    expect(screen.getByText(/No consent recorded yet/i)).toBeInTheDocument();
  });
});
