import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import CardNotFound from "./not-found";

describe("CardNotFound", () => {
  it("shows a clear, non-technical explanation for a nonexistent card", () => {
    render(<CardNotFound />);

    expect(
      screen.getByText("This card could not be found."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/mistyped or no longer valid/i),
    ).toBeInTheDocument();
  });
});
