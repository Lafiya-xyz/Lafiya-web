import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./sessions-actions", () => ({
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));

import { SessionsPanel, type SessionListItem } from "./sessions-panel";

const sessions: SessionListItem[] = [
  {
    session_id: "11111111-1111-4111-8111-111111111111",
    browser: "Chrome",
    os: "Android",
    created_at: "2026-09-01T08:00:00.000Z",
    last_seen_at: "2026-09-30T08:00:00.000Z",
    current: true,
  },
  {
    session_id: "22222222-2222-4222-8222-222222222222",
    browser: "Safari",
    os: "iOS",
    created_at: "2026-08-20T08:00:00.000Z",
    last_seen_at: "2026-09-28T08:00:00.000Z",
    current: false,
  },
  {
    session_id: "33333333-3333-4333-8333-333333333333",
    browser: "Other",
    os: "Other",
    created_at: "2026-08-10T08:00:00.000Z",
    last_seen_at: "2026-09-02T08:00:00.000Z",
    current: false,
  },
];

describe("SessionsPanel (#523)", () => {
  it("lists every session with a coarse device label and marks this device", () => {
    render(<SessionsPanel sessions={sessions} />);
    const items = screen.getAllByTestId("session-item");

    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Chrome on Android");
    expect(items[0]).toHaveTextContent("This device");
    expect(items[1]).toHaveTextContent("Safari on iOS");
    expect(items[2]).toHaveTextContent("Unknown device");
  });

  it("offers revoke only for other sessions, plus sign out everywhere else", () => {
    render(<SessionsPanel sessions={sessions} />);
    const [current, ...others] = screen.getAllByTestId("session-item");

    expect(within(current).queryByTestId("session-revoke")).toBeNull();
    for (const item of others) {
      expect(within(item).getByTestId("session-revoke")).toBeInTheDocument();
    }
    expect(screen.getByTestId("sessions-revoke-others")).toHaveTextContent(
      "Sign out everywhere else",
    );
  });

  it("hides 'sign out everywhere else' when this is the only session", () => {
    render(<SessionsPanel sessions={[sessions[0]]} />);
    expect(screen.queryByTestId("sessions-revoke-others")).toBeNull();
  });

  it("shows no IP address or location", () => {
    render(<SessionsPanel sessions={sessions} />);
    const text = screen.getByTestId("sessions-panel").textContent ?? "";
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).toContain("Locations and IP addresses are never recorded");
  });
});
