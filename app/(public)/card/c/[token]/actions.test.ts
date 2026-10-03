import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mocks.cookieSet })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: mocks.rpc }),
}));

import { hashCardPin } from "@/lib/emergency/card-pin";

import { submitCardPin } from "./actions";

const token = `lafiya_e1_${"A".repeat(43)}`;
const path = `/card/c/${token}`;

// In-memory stand-in mirroring the SQL contract of begin_card_pin_attempt /
// complete_card_pin_success: an attempt is reserved before verification and
// never more than five failures are allowed.
const db = {
  pinHash: "",
  failedAttempts: 0,
  unlockDigest: null as string | null,
  events: [] as string[],
};

function submit(pin: string) {
  const form = new FormData();
  form.set("token", token);
  form.set("pin", pin);
  return submitCardPin(form);
}

beforeAll(async () => {
  db.pinHash = await hashCardPin("482913");
});

beforeEach(() => {
  db.failedAttempts = 0;
  db.unlockDigest = null;
  db.events = [];
  mocks.cookieSet.mockReset();
  mocks.rpc.mockImplementation(
    async (name: string, args: Record<string, string>) => {
      switch (name) {
        case "begin_card_pin_attempt": {
          if (db.failedAttempts >= 5) {
            return {
              data: [
                { capability_id: "cap-1", pin_hash: null, allowed: false },
              ],
              error: null,
            };
          }
          db.failedAttempts += 1;
          return {
            data: [
              { capability_id: "cap-1", pin_hash: db.pinHash, allowed: true },
            ],
            error: null,
          };
        }
        case "complete_card_pin_success":
          db.failedAttempts = 0;
          db.unlockDigest = args.p_unlock_digest;
          return { error: null };
        case "record_card_access_event":
          db.events.push(args.p_outcome);
          return { error: null };
        default:
          throw new Error(`unexpected rpc ${name}`);
      }
    },
  );
});

describe("submitCardPin (issue #631)", () => {
  it("unlocks with the correct PIN via a path-scoped httpOnly cookie", async () => {
    await expect(submit("482913")).rejects.toThrow(`REDIRECT:${path}`);
    expect(db.unlockDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "lafiya_card_pin",
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        path,
        maxAge: 900,
      }),
    );
    expect(db.events).toEqual(["pin_success"]);
  });

  it("locks out brute force after five wrong PINs, even for the right PIN", async () => {
    for (let i = 0; i < 5; i += 1) {
      await expect(submit(String(100000 + i))).rejects.toThrow(
        `REDIRECT:${path}?pin=invalid`,
      );
    }
    await expect(submit("482913")).rejects.toThrow(
      `REDIRECT:${path}?pin=locked`,
    );
    expect(mocks.cookieSet).not.toHaveBeenCalled();
    expect(db.unlockDigest).toBeNull();
    expect(db.events).toEqual([
      "pin_failure",
      "pin_failure",
      "pin_failure",
      "pin_failure",
      "pin_failure",
      "pin_locked",
    ]);
  });

  it("rejects malformed PINs without consuming an attempt", async () => {
    await expect(submit("12ab")).rejects.toThrow(
      `REDIRECT:${path}?pin=invalid`,
    );
    expect(db.failedAttempts).toBe(0);
  });

  it("returns not found for a malformed token", async () => {
    const form = new FormData();
    form.set("token", "not-a-token");
    form.set("pin", "482913");
    await expect(submitCardPin(form)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
