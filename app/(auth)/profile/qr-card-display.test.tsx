import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QrCardDisplay } from "./qr-card-display";

describe("QrCardDisplay", () => {
  it("renders a QR image and the plain-text card URL", async () => {
    const cardUrl =
      "https://lafiya.example/card/11111111-1111-1111-1111-111111111111";
    const jsx = await QrCardDisplay({
      cardUrl,
      legacySunsetAt: "2027-01-01T00:00:00.000Z",
    });
    render(jsx);

    expect(screen.getByText(cardUrl)).toBeInTheDocument();

    const image = screen.getByRole("img", {
      name: /qr code linking to your public emergency card/i,
    });
    expect(image).toBeInTheDocument();
  });

  it("includes a visually-hidden description of the QR code's purpose for screen readers", async () => {
    const cardUrl =
      "https://lafiya.example/card/11111111-1111-1111-1111-111111111111";
    const jsx = await QrCardDisplay({
      cardUrl,
      legacySunsetAt: "2027-01-01T00:00:00.000Z",
    });
    render(jsx);

    // The sr-only paragraph must be present in the DOM so screen readers can
    // read it, even though it is visually hidden via CSS.
    const srText = screen.getByText(/first responder or clinician/i);
    expect(srText).toBeInTheDocument();
    // It should sit in a <p> element with the sr-only class.
    expect(srText.tagName.toLowerCase()).toBe("p");
    expect(srText.className).toContain("sr-only");
  });
});
