/**
 * Issue #762: drug-class cross-reactivity notes for recorded allergies.
 *
 * A reviewed, versioned mapping from allergen substances to drug classes and
 * "consider avoiding" relations. Only high-confidence relations are rendered
 * to responders so the card does not create alert fatigue. Pure and
 * deterministic: no network calls, safe for offline renders.
 *
 * Any change to RELATIONS must bump CROSS_REACTIVITY_VERSION and be signed
 * off by a named clinical reviewer in the PR.
 */

export const CROSS_REACTIVITY_VERSION = "2026-10-22.1";

export type EvidenceLevel = "high" | "moderate" | "low";

export type CrossReactivityRelation = {
  id: string;
  /** Lower-case substance names / class names that trigger the relation. */
  allergens: readonly string[];
  /** The allergen's own drug class. */
  allergenClass: string;
  /** Related drugs/classes the responder should consider avoiding. */
  considerAvoiding: readonly string[];
  evidence: EvidenceLevel;
  source: string;
};

export const RELATIONS: readonly CrossReactivityRelation[] = [
  {
    id: "penicillin-beta-lactam",
    allergens: [
      "penicillin",
      "amoxicillin",
      "ampicillin",
      "amoxicillin-clavulanate",
      "flucloxacillin",
      "cloxacillin",
      "piperacillin",
    ],
    allergenClass: "Penicillins",
    considerAvoiding: ["other penicillins", "co-amoxiclav"],
    evidence: "high",
    source:
      "Khan DA et al. Drug allergy: a 2022 practice parameter update. J Allergy Clin Immunol. 2022;150(6):1333-1393.",
  },
  {
    id: "penicillin-cephalosporin",
    allergens: ["penicillin", "amoxicillin", "ampicillin"],
    allergenClass: "Penicillins",
    considerAvoiding: ["first-generation cephalosporins (e.g. cefalexin)"],
    evidence: "moderate",
    source:
      "Khan DA et al. Drug allergy: a 2022 practice parameter update. J Allergy Clin Immunol. 2022;150(6):1333-1393.",
  },
  {
    id: "cephalosporin-class",
    allergens: [
      "cephalosporin",
      "cefalexin",
      "cephalexin",
      "ceftriaxone",
      "cefuroxime",
      "cefixime",
    ],
    allergenClass: "Cephalosporins",
    considerAvoiding: ["cephalosporins with similar side chains"],
    evidence: "high",
    source:
      "Khan DA et al. Drug allergy: a 2022 practice parameter update. J Allergy Clin Immunol. 2022;150(6):1333-1393.",
  },
  {
    id: "sulfonamide-antibiotic",
    allergens: [
      "sulfonamide antibiotic",
      "sulfamethoxazole",
      "co-trimoxazole",
      "cotrimoxazole",
      "trimethoprim-sulfamethoxazole",
      "sulfadiazine",
    ],
    allergenClass: "Sulfonamide antibiotics",
    considerAvoiding: ["other sulfonamide antibiotics"],
    evidence: "high",
    // Non-antibiotic sulfonamides (furosemide, thiazides) are deliberately
    // NOT implied: cross-reactivity is not supported by evidence.
    source:
      "Strom BL et al. Absence of cross-reactivity between sulfonamide antibiotics and sulfonamide nonantibiotics. N Engl J Med. 2003;349:1628-1635.",
  },
  {
    id: "nsaid-cox1",
    allergens: [
      "aspirin",
      "ibuprofen",
      "diclofenac",
      "naproxen",
      "nsaid",
      "nsaids",
    ],
    allergenClass: "NSAIDs",
    considerAvoiding: ["aspirin and other non-selective NSAIDs"],
    evidence: "high",
    source:
      "Kowalski ML et al. Classification and practical approach to the diagnosis and management of hypersensitivity to NSAIDs. Allergy. 2013;68(10):1219-1232.",
  },
  {
    id: "carbapenem-penicillin",
    allergens: ["penicillin"],
    allergenClass: "Penicillins",
    considerAvoiding: ["carbapenems"],
    evidence: "low",
    source:
      "Khan DA et al. Drug allergy: a 2022 practice parameter update. J Allergy Clin Immunol. 2022;150(6):1333-1393.",
  },
];

export const CROSS_REACTIVITY_DISCLAIMER =
  "Related drugs may also be unsafe: confirm before giving. This is not a prescribing instruction.";

export type CrossReactivityNote = {
  allergen: string;
  relationId: string;
  allergenClass: string;
  considerAvoiding: readonly string[];
};

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns high-confidence cross-reactivity notes for the given allergen
 * substance names. Lower-evidence relations are never surfaced. Matching is
 * exact (after normalisation) to avoid false implications.
 */
export function crossReactivityNotes(
  substances: readonly string[],
  relations: readonly CrossReactivityRelation[] = RELATIONS,
): CrossReactivityNote[] {
  const notes: CrossReactivityNote[] = [];
  const seen = new Set<string>();
  for (const raw of substances) {
    const allergen = normalise(raw);
    if (allergen.length === 0) continue;
    for (const relation of relations) {
      if (relation.evidence !== "high") continue;
      if (!relation.allergens.includes(allergen)) continue;
      if (seen.has(relation.id)) continue;
      seen.add(relation.id);
      notes.push({
        allergen: raw.trim(),
        relationId: relation.id,
        allergenClass: relation.allergenClass,
        considerAvoiding: relation.considerAvoiding,
      });
    }
  }
  return notes;
}
