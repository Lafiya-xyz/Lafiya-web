import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  generateCardPin,
  hashCardPin,
  pinGatedFields,
  verifyCardPin,
  withholdPinGatedFields,
} from "./card-pin";

describe("card PIN (issue #631)", () => {
  it("generates uniformly formatted 6-digit PINs", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateCardPin()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("stores only an Argon2id hash that verifies the right PIN only", async () => {
    const hash = await hashCardPin("012345");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain("012345");
    await expect(verifyCardPin("012345", hash)).resolves.toBe(true);
    await expect(verifyCardPin("012346", hash)).resolves.toBe(false);
    await expect(verifyCardPin("12345", hash)).resolves.toBe(false);
    await expect(verifyCardPin("012345", "$argon2id$bogus")).resolves.toBe(
      false,
    );
  });

  it("uses a fresh salt per hash", async () => {
    expect(await hashCardPin("111111")).not.toBe(await hashCardPin("111111"));
  });

  it("never gates critical fields, whatever the policy says", () => {
    expect(
      pinGatedFields({
        version: 1,
        fields: {},
        requires_card_pin: [
          "allergies",
          "blood_group",
          "genotype",
          "emergency_contacts",
          "name",
          "medications",
          "chronic_conditions",
          "chronic_conditions",
        ],
      }),
    ).toEqual(["medications", "chronic_conditions"]);
  });

  it("withholds gated fields and marks them pin_required", () => {
    const card = {
      allergies: ["Penicillin"],
      medications: ["Tenofovir"],
      chronic_conditions: ["HIV"],
      disclosure_states: {
        allergies: "disclosed",
        medications: "disclosed",
        chronic_conditions: "disclosed",
      },
    };
    const redacted = withholdPinGatedFields(card, [
      "medications",
      "chronic_conditions",
      "allergies",
    ]);
    expect(redacted).toEqual({
      allergies: ["Penicillin"],
      medications: null,
      chronic_conditions: null,
      disclosure_states: {
        allergies: "disclosed",
        medications: "pin_required",
        chronic_conditions: "pin_required",
      },
    });
    expect(withholdPinGatedFields(card, [])).toBe(card);
  });
});
