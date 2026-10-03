import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  blockingKeyHash,
  computeBlockingKeys,
  normalizeNameDob,
  normalizePhone,
} from "./duplicates";

const SECRET = "s".repeat(32);

describe("duplicate blocking keys (issue #628)", () => {
  it("normalizes local and international spellings of one phone number", () => {
    expect(normalizePhone("0803 123 4567")).toBe("2348031234567");
    expect(normalizePhone("+234 (803) 123-4567")).toBe("2348031234567");
    expect(normalizePhone("002348031234567")).toBe("2348031234567");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it("matches names regardless of order, case, accents, and punctuation", () => {
    expect(normalizeNameDob("Amina  Yusuf", "1998-01-02")).toBe(
      normalizeNameDob("YUSUF, Amína", "1998-01-02"),
    );
    expect(normalizeNameDob("Amina Yusuf", "1998-01-03")).not.toBe(
      normalizeNameDob("Amina Yusuf", "1998-01-02"),
    );
    expect(normalizeNameDob("Amina Yusuf", null)).toBeNull();
  });

  it("stores only keyed hashes that depend on the server secret", () => {
    const keys = computeBlockingKeys(SECRET, {
      phone: "08031234567",
      name: "Amina Yusuf",
      dateOfBirth: "1998-01-02",
    });
    expect(keys.map((key) => key.keyType)).toEqual(["phone", "name_dob"]);
    for (const key of keys) {
      expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const serialized = JSON.stringify(keys);
    expect(serialized).not.toContain("2348031234567");
    expect(serialized).not.toContain("amina");
    expect(blockingKeyHash(SECRET, "phone", "2348031234567")).not.toBe(
      blockingKeyHash("t".repeat(32), "phone", "2348031234567"),
    );
    expect(keys[0].keyHash).toBe(
      computeBlockingKeys(SECRET, { phone: "+2348031234567" })[0].keyHash,
    );
  });
});
