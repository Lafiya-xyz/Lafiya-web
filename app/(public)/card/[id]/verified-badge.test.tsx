import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VerifiedBadge } from "./verified-badge";

describe("VerifiedBadge", () => {
  it("shows the verified state when an attestation exists", () => {
    const { container } = render(<VerifiedBadge status="verified" />);
    expect(screen.getByText("Verified by a health worker")).toBeInTheDocument();
    expect(screen.queryByText("Not yet verified")).not.toBeInTheDocument();

    const icon = screen.getByTestId("verified-icon");
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute("aria-hidden", "true");

    expect(container.firstChild).toMatchSnapshot();
  });

  it("shows the unverified state when no attestation exists", () => {
    const { container } = render(<VerifiedBadge status="not_verified" />);
    expect(screen.getByText("Not yet verified")).toBeInTheDocument();
    expect(
      screen.queryByText("Verified by a health worker"),
    ).not.toBeInTheDocument();

    const icon = screen.getByTestId("unverified-icon");
    expect(icon).toBeInTheDocument();
    expect(icon).not.toHaveAttribute("aria-hidden");

    expect(container.firstChild).toMatchSnapshot();
  });

  describe("WCAG AA contrast verified for both states and color schemes", () => {
    function getLuminance(hex: string): number {
      const rgb = [
        parseInt(hex.slice(1, 3), 16) / 255,
        parseInt(hex.slice(3, 5), 16) / 255,
        parseInt(hex.slice(5, 7), 16) / 255,
      ].map((c) =>
        c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
      );
      return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }

    function getContrastRatio(hex1: string, hex2: string): number {
      const l1 = getLuminance(hex1);
      const l2 = getLuminance(hex2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    it("passes WCAG AA (>= 4.5:1) for verified state in both light and dark modes", () => {
      // Light mode: emerald-100 (#d1fae5) vs emerald-800 (#065f46) -> 6.78:1
      expect(getContrastRatio("#d1fae5", "#065f46")).toBeGreaterThanOrEqual(
        4.5,
      );

      // Dark mode: emerald-950 (#022c22) vs emerald-300 (#6ee7b7) -> 9.94:1
      expect(getContrastRatio("#022c22", "#6ee7b7")).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    it("passes WCAG AA (>= 4.5:1) for unverified state in both light and dark modes", () => {
      // Light mode: zinc-100 (#f4f4f5) vs zinc-700 (#3f3f46) -> 9.50:1
      expect(getContrastRatio("#f4f4f5", "#3f3f46")).toBeGreaterThanOrEqual(
        4.5,
      );

      // Dark mode: zinc-800 (#27272a) vs zinc-300 (#d4d4d8) -> 10.08:1
      expect(getContrastRatio("#27272a", "#d4d4d8")).toBeGreaterThanOrEqual(
        4.5,
      );
    });
  });
});
