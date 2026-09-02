import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AccessSummary } from "./access-summary";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderSummary(
  viewsLast30Days: number,
  lastViewedAt: string | null,
) {
  render(
    <AccessSummary
      viewsLast30Days={viewsLast30Days}
      lastViewedAt={lastViewedAt}
    />,
  );
  // The section is labelled by its heading — select it for scoped assertions.
  return screen.getByRole("region", { name: /card access summary/i });
}

// ---------------------------------------------------------------------------
// Zero-entry (empty) state
// ---------------------------------------------------------------------------

describe("AccessSummary — zero views", () => {
  it("renders the section heading", () => {
    renderSummary(0, null);
    expect(
      screen.getByRole("heading", { name: /card access summary/i }),
    ).toBeInTheDocument();
  });

  it("shows an explicit empty-state message, not a blank area", () => {
    const section = renderSummary(0, null);
    expect(
      within(section).getByText(
        /no successful card views were recorded in the last 30 days/i,
      ),
    ).toBeInTheDocument();
  });

  it("does not render the 'most recent view' line when there are no views", () => {
    const section = renderSummary(0, null);
    expect(
      within(section).queryByText(/most recent successful view/i),
    ).not.toBeInTheDocument();
  });

  it("shows the privacy-preserving notice in all states", () => {
    const section = renderSummary(0, null);
    expect(
      within(section).getByText(/privacy-preserving aggregate/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Single view
// ---------------------------------------------------------------------------

describe("AccessSummary — single view", () => {
  const AT = "2025-06-15T14:30:00.000Z";

  it("uses the singular 'view' form for exactly 1 view", () => {
    const section = renderSummary(1, AT);
    // Must say "1 successful card view recorded" (singular)
    expect(within(section).getByText(/\b1 successful card view\b/i)).toBeInTheDocument();
    // Must NOT say "views" (plural)
    expect(
      within(section).queryByText(/\b1 successful card views\b/i),
    ).not.toBeInTheDocument();
  });

  it("renders the most-recent timestamp when lastViewedAt is provided", () => {
    const section = renderSummary(1, AT);
    const recentLine = within(section).getByText(
      /most recent successful view/i,
    );
    expect(recentLine).toBeInTheDocument();
    // The formatted date must appear somewhere in the same element or its
    // siblings — we check the section as a whole rather than an exact locale
    // string (which varies by test runner locale).
    expect(section.textContent).toMatch(/jun|june|15|2025/i);
  });
});

// ---------------------------------------------------------------------------
// Multiple views — order and content determinism
// ---------------------------------------------------------------------------

describe("AccessSummary — multiple views", () => {
  it("uses the plural form for more than 1 view", () => {
    const section = renderSummary(7, "2025-07-01T10:00:00.000Z");
    expect(
      within(section).getByText(/7 successful card views/i),
    ).toBeInTheDocument();
  });

  it("renders the most-recent timestamp deterministically for a given date", () => {
    // Both calls with the same timestamp must produce the same output.
    const AT = "2025-12-25T08:00:00.000Z";

    const { unmount } = render(
      <AccessSummary viewsLast30Days={3} lastViewedAt={AT} />,
    );
    const firstRender = screen
      .getByRole("region", { name: /card access summary/i })
      .textContent;
    unmount();

    render(<AccessSummary viewsLast30Days={3} lastViewedAt={AT} />);
    const secondRender = screen
      .getByRole("region", { name: /card access summary/i })
      .textContent;

    expect(firstRender).toBe(secondRender);
  });

  it("shows count before timestamp (most informative fact first)", () => {
    const section = renderSummary(5, "2025-09-10T09:00:00.000Z");
    const text = section.textContent ?? "";
    const countIndex = text.search(/5 successful card views/i);
    const recentIndex = text.search(/most recent successful view/i);
    // Count summary must appear before the most-recent line
    expect(countIndex).toBeGreaterThanOrEqual(0);
    expect(recentIndex).toBeGreaterThan(countIndex);
  });

  it("does not render the most-recent line when lastViewedAt is null even if count > 0", () => {
    // Edge case: views were counted in the 30-day window but we have no
    // lastViewedAt timestamp (data inconsistency or future schema gap).
    const section = renderSummary(3, null);
    expect(
      within(section).queryByText(/most recent successful view/i),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("AccessSummary — accessibility", () => {
  it("uses a <section> with an accessible name so screen readers can navigate to it", () => {
    renderSummary(2, "2025-08-01T12:00:00.000Z");
    // getByRole('region') only matches sections with an accessible name.
    expect(
      screen.getByRole("region", { name: /card access summary/i }),
    ).toBeInTheDocument();
  });
});
