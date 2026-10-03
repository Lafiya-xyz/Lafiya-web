import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const logNfcCardWrite = vi.fn();
vi.mock("./actions", () => ({
  logNfcCardWrite: (...args: unknown[]) => logNfcCardWrite(...args),
}));

import { NfcWriteButton } from "./nfc-write-button";

const CARD_URL = "https://lafiya.example/card/c/lafiya_e1_test-token";

function setup(props?: Partial<ComponentProps<typeof NfcWriteButton>>) {
  const user = userEvent.setup();
  render(
    <NfcWriteButton
      cardUrl={CARD_URL}
      revokeHref="#capability-share-heading"
      {...props}
    />,
  );
  return { user };
}

function openDialog(user: ReturnType<typeof userEvent.setup>) {
  const dialog = screen.getByRole("dialog", { hidden: true });
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));
  return dialog;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Unsupported browsers
// ---------------------------------------------------------------------------

describe("NfcWriteButton — Web NFC unsupported", () => {
  // jsdom does not define NDEFReader by default, which is exactly the
  // "unsupported browser" case this test covers — no stubbing needed.
  it("shows a graceful explanation instead of the write control", () => {
    setup();
    expect(
      screen.getByText(/needs chrome on an android phone/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /write to nfc tag/i }),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Supported browsers — confirmation + revocation warning
// ---------------------------------------------------------------------------

describe("NfcWriteButton — Web NFC supported", () => {
  let mockWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWrite = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("NDEFReader", vi.fn().mockImplementation(() => ({
      write: mockWrite,
    })));
  });

  it("renders the trigger button", () => {
    setup();
    expect(
      screen.getByRole("button", { name: /write to nfc tag/i }),
    ).toBeInTheDocument();
  });

  it("opens a confirmation dialog with a revocation warning and link", async () => {
    const { user } = setup();
    const dialog = openDialog(user);

    await user.click(screen.getByRole("button", { name: /write to nfc tag/i }));

    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(
      within(dialog).getByText(/anyone who taps a phone/i),
    ).toBeInTheDocument();
    const revokeLink = within(dialog).getByRole("link", {
      name: /revoke access/i,
    });
    expect(revokeLink).toHaveAttribute("href", "#capability-share-heading");
  });

  it("writes a URL NDEF record with the card link when confirmed", async () => {
    const { user } = setup();
    openDialog(user);

    await user.click(screen.getByRole("button", { name: /write to nfc tag/i }));
    await user.click(screen.getByRole("button", { name: /^write tag$/i }));

    await waitFor(() => {
      expect(mockWrite).toHaveBeenCalledWith({
        records: [{ recordType: "url", data: CARD_URL }],
      });
    });
  });

  it("shows success feedback and logs the write outcome (not the URL)", async () => {
    const { user } = setup();
    openDialog(user);

    await user.click(screen.getByRole("button", { name: /write to nfc tag/i }));
    await user.click(screen.getByRole("button", { name: /^write tag$/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/written/i);
    expect(logNfcCardWrite).toHaveBeenCalledWith("success");
    expect(logNfcCardWrite).not.toHaveBeenCalledWith(
      expect.stringContaining(CARD_URL),
    );
  });

  it("shows a clear error and logs failure when permission is denied", async () => {
    mockWrite.mockRejectedValueOnce(
      new DOMException("denied", "NotAllowedError"),
    );
    const { user } = setup();
    openDialog(user);

    await user.click(screen.getByRole("button", { name: /write to nfc tag/i }));
    await user.click(screen.getByRole("button", { name: /^write tag$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /permission was denied/i,
    );
    expect(logNfcCardWrite).toHaveBeenCalledWith("error");
  });

  it("shows a clear error when the write fails for another reason", async () => {
    mockWrite.mockRejectedValueOnce(new Error("boom"));
    const { user } = setup();
    openDialog(user);

    await user.click(screen.getByRole("button", { name: /write to nfc tag/i }));
    await user.click(screen.getByRole("button", { name: /^write tag$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not write the card link/i,
    );
  });

  it("does not write when the dialog is cancelled", async () => {
    const { user } = setup();
    const dialog = openDialog(user);

    await user.click(screen.getByRole("button", { name: /write to nfc tag/i }));
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(mockWrite).not.toHaveBeenCalled();
  });
});
