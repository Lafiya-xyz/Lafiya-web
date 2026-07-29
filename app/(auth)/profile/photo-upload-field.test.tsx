import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PhotoUploadField } from "./photo-upload-field";

function makeFile(name: string, type: string, sizeBytes: number): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type });
}

describe("PhotoUploadField", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects a disallowed MIME type without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // user-event's upload() filters files against the input's `accept`
    // attribute by default (matching real browser file-picker behavior),
    // which would silently drop this PDF before it ever reaches the
    // component. Disable that so this test can exercise the app's own
    // MIME-type validation, not the browser's.
    const user = userEvent.setup({ applyAccept: false });

    render(<PhotoUploadField userId="user-1" initialUrl={null} />);

    const input = screen.getByLabelText(/add photo/i, {
      selector: "input",
    }) as HTMLInputElement;
    const badFile = makeFile("doc.pdf", "application/pdf", 1024);

    await user.upload(input, badFile);

    expect(
      await screen.findByText("Photo must be a PNG, JPEG, or WebP image."),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a file over 5 MB without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();

    render(<PhotoUploadField userId="user-1" initialUrl={null} />);

    const input = screen.getByLabelText(/add photo/i, {
      selector: "input",
    }) as HTMLInputElement;
    const oversized = makeFile("big.png", "image/png", 5 * 1024 * 1024 + 1);

    await user.upload(input, oversized);

    expect(
      await screen.findByText("Photo must be under 5 MB."),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uploads a valid file and sets the hidden photoUrl input on success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        publicUrl: "https://storage.example/avatars/user-1.png",
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();

    const { container } = render(
      <PhotoUploadField userId="user-1" initialUrl={null} />,
    );

    const input = screen.getByLabelText(/add photo/i, {
      selector: "input",
    }) as HTMLInputElement;
    const goodFile = makeFile("photo.png", "image/png", 1024);

    await user.upload(input, goodFile);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/profile/photo",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const hiddenInput = container.querySelector(
      'input[name="photoUrl"]',
    ) as HTMLInputElement;

    await waitFor(() => {
      expect(hiddenInput.value).toContain(
        "https://storage.example/avatars/user-1.png",
      );
    });
    // Cache-busting query param appended after upload.
    expect(hiddenInput.value).toMatch(/\?updated=\d+$/);
  });

  it("shows an error message when the upload call fails", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "Storage is temporarily unavailable." }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();

    render(<PhotoUploadField userId="user-1" initialUrl={null} />);

    const input = screen.getByLabelText(/add photo/i, {
      selector: "input",
    }) as HTMLInputElement;
    const goodFile = makeFile("photo.jpg", "image/jpeg", 2048);

    await user.upload(input, goodFile);

    expect(
      await screen.findByText("Storage is temporarily unavailable."),
    ).toBeInTheDocument();
  });
});