import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "./error";

describe("ErrorPage", () => {
  it("renders a recovery message and calls reset", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(<ErrorPage error={new Error("boom")} reset={reset} />);

    expect(
      screen.getByRole("heading", {
        name: /we couldn’t load this page right now/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Unhandled application error",
      expect.objectContaining({ message: "boom" }),
    );
  });
});
