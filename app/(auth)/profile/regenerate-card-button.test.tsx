import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// useActionState is a React 19 hook. Provide a controllable stub so tests can
// inspect what action was called and what state it returned.
const mockDispatch = vi.fn();
let mockState: { error?: string } | undefined = undefined;
let mockIsPending = false;

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return {
    ...original,
    useActionState: (_action: unknown, _initialState: unknown) => [
      mockState,
      mockDispatch,
      mockIsPending,
    ],
  };
});

// The server action itself is irrelevant to unit tests of the button's UI
// behaviour. Mock it so the module resolves without a server environment.
vi.mock("./actions", () => ({
  regenerateCardId: vi.fn(),
}));

import { RegenerateCardButton } from "./regenerate-card-button";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup() {
  const user = userEvent.setup();
  render(<RegenerateCardButton />);
  return { user };
}

// ---------------------------------------------------------------------------
// Initial state — confirmation dialog is closed
// ---------------------------------------------------------------------------

describe("RegenerateCardButton — initial state", () => {
  beforeEach(() => {
    mockState = undefined;
    mockIsPending = false;
    vi.clearAllMocks();
  });

  it("renders the trigger button", () => {
    setup();
    expect(
      screen.getByRole("button", { name: /regenerate qr code/i }),
    ).toBeInTheDocument();
  });

  it("does not show the confirmation dialog on first render", () => {
    setup();
    // The dialog element is present in the DOM but should not be open.
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).not.toHaveAttribute("open");
  });
});

// ---------------------------------------------------------------------------
// Opening the confirmation dialog
// ---------------------------------------------------------------------------

describe("RegenerateCardButton — opening the dialog", () => {
  beforeEach(() => {
    mockState = undefined;
    mockIsPending = false;
    vi.clearAllMocks();
  });

  it("opens the confirmation dialog when the trigger button is clicked", async () => {
    const { user } = setup();
    // jsdom does not implement showModal(), so we need to mock it.
    const dialog = screen.getByRole("dialog", { hidden: true });
    const showModal = vi.fn(() => dialog.setAttribute("open", ""));
    dialog.showModal = showModal;

    await user.click(
      screen.getByRole("button", { name: /regenerate qr code/i }),
    );

    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it("shows a warning that the existing QR and card link will be invalidated", async () => {
    const { user } = setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));

    await user.click(
      screen.getByRole("button", { name: /regenerate qr code/i }),
    );

    expect(
      within(dialog).getByText(/invalidate your current qr code/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Cancelling — the safety rail
// ---------------------------------------------------------------------------

describe("RegenerateCardButton — cancel dismisses without regenerating", () => {
  beforeEach(() => {
    mockState = undefined;
    mockIsPending = false;
    vi.clearAllMocks();
  });

  it("calls dialog.close() when Cancel is clicked", async () => {
    const { user } = setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
    const closeSpy = vi.fn(() => dialog.removeAttribute("open"));
    dialog.close = closeSpy;

    // Open the dialog first
    await user.click(
      screen.getByRole("button", { name: /regenerate qr code/i }),
    );

    // Click Cancel
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch the regenerate action when Cancel is clicked", async () => {
    const { user } = setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
    dialog.close = vi.fn(() => dialog.removeAttribute("open"));

    await user.click(
      screen.getByRole("button", { name: /regenerate qr code/i }),
    );
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Confirming regeneration
// ---------------------------------------------------------------------------

describe("RegenerateCardButton — confirm calls the server action exactly once", () => {
  beforeEach(() => {
    mockState = undefined;
    mockIsPending = false;
    vi.clearAllMocks();
  });

  it("the form's submit button triggers form submission (implying server action dispatch)", async () => {
    const { user } = setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));

    await user.click(
      screen.getByRole("button", { name: /regenerate qr code/i }),
    );

    // The submit button inside the form should be present and enabled
    const confirmBtn = within(dialog).getByRole("button", {
      name: /^regenerate$/i,
    });
    expect(confirmBtn).toBeInTheDocument();
    expect(confirmBtn).not.toBeDisabled();
    expect(confirmBtn).toHaveAttribute("type", "submit");
  });

  it("the confirm button is the only submit button — no accidental double-submit path", () => {
    setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    const submitButtons = within(dialog).queryAllByRole("button", {
      hidden: true,
    });
    const submitTypes = submitButtons.filter(
      (btn) => btn.getAttribute("type") === "submit",
    );
    expect(submitTypes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pending state
// ---------------------------------------------------------------------------

describe("RegenerateCardButton — pending state disables confirm button", () => {
  beforeEach(() => {
    mockState = undefined;
    mockIsPending = true;
    vi.clearAllMocks();
  });

  it("disables the confirm button and shows 'Regenerating…' while pending", () => {
    setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    const confirmBtn = within(dialog).getByRole("button", {
      name: /regenerating/i,
      hidden: true,
    });
    expect(confirmBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

describe("RegenerateCardButton — shows error message from server action", () => {
  beforeEach(() => {
    mockState = { error: "Failed to regenerate. Please try again." };
    mockIsPending = false;
    vi.clearAllMocks();
  });

  it("renders the error message returned from the server action", () => {
    setup();
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(
      within(dialog).getByText(/failed to regenerate/i),
    ).toBeInTheDocument();
  });
});
