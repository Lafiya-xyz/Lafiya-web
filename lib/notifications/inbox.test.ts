import { describe, expect, it } from "vitest";

import {
  parseInboxPayload,
  unreadCount,
  upsertNotification,
  type InboxNotification,
} from "./inbox";

const row = (
  id: string,
  created_at: string,
  read_at: string | null = null,
): InboxNotification => ({
  id,
  type: "new_sign_in",
  body_key: "notifications.new_sign_in",
  created_at,
  read_at,
});

describe("inbox", () => {
  it("accepts a well-formed payload", () => {
    expect(
      parseInboxPayload({
        event_key: "evt-1",
        type: "new_sign_in",
        body_key: "notifications.new_sign_in",
        card_public_id: "abc",
      }),
    ).not.toBeNull();
  });

  it.each([
    { event_key: "", type: "new_sign_in", body_key: "a", card_public_id: "x" },
    { event_key: "e", type: "unknown", body_key: "a", card_public_id: "x" },
    {
      event_key: "e",
      type: "new_sign_in",
      body_key: "Free text with PHI",
      card_public_id: "x",
    },
    { event_key: "e", type: "new_sign_in", body_key: "a" },
  ])("rejects unsafe payload %#", (payload) => {
    expect(parseInboxPayload(payload)).toBeNull();
  });

  it("counts unread and de-duplicates realtime updates", () => {
    let items = [row("1", "2026-10-01T00:00:00Z")];
    items = upsertNotification(items, row("2", "2026-10-02T00:00:00Z"));
    items = upsertNotification(
      items,
      row("1", "2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z"),
    );
    expect(items.map((i) => i.id)).toEqual(["2", "1"]);
    expect(unreadCount(items)).toBe(1);
  });
});
