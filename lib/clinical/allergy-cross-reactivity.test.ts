import { describe, expect, it } from "vitest";

import {
  CROSS_REACTIVITY_DISCLAIMER,
  RELATIONS,
  crossReactivityNotes,
} from "./allergy-cross-reactivity";

describe("crossReactivityNotes", () => {
  it.each(RELATIONS.filter((r) => r.evidence === "high"))(
    "surfaces high-confidence relation $id for each allergen",
    (relation) => {
      for (const allergen of relation.allergens) {
        const ids = crossReactivityNotes([allergen]).map((n) => n.relationId);
        expect(ids).toContain(relation.id);
      }
    },
  );

  it.each(RELATIONS.filter((r) => r.evidence !== "high"))(
    "never surfaces lower-evidence relation $id",
    (relation) => {
      for (const allergen of relation.allergens) {
        const ids = crossReactivityNotes([allergen]).map((n) => n.relationId);
        expect(ids).not.toContain(relation.id);
      }
    },
  );

  it("every relation cites a source", () => {
    for (const relation of RELATIONS) {
      expect(relation.source.length).toBeGreaterThan(10);
    }
  });

  it.each([
    "furosemide",
    "hydrochlorothiazide",
    "peanut",
    "latex",
    "paracetamol",
    "penicillamine",
    "",
  ])("does not imply a drug-class relation for %s", (substance) => {
    expect(crossReactivityNotes([substance])).toEqual([]);
  });

  it("normalises case and whitespace", () => {
    expect(crossReactivityNotes(["  PeniCillin "])[0]?.relationId).toBe(
      "penicillin-beta-lactam",
    );
  });

  it("deduplicates relations across substances", () => {
    expect(crossReactivityNotes(["penicillin", "amoxicillin"])).toHaveLength(1);
  });

  it("disclaimer is non-prescriptive", () => {
    expect(CROSS_REACTIVITY_DISCLAIMER).toMatch(/confirm/);
    expect(CROSS_REACTIVITY_DISCLAIMER).toMatch(/not a prescribing/);
  });
});
