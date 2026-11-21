/**
 * Issue #917: emergency-relevant drug–drug interaction warnings.
 *
 * A curated, versioned ruleset of clinically significant interactions between
 * drug classes that matter in an emergency (bleeding, serotonin syndrome,
 * QT prolongation, hyperkalaemia, hypoglycaemia, respiratory depression).
 * Pure and deterministic: no network calls, safe for offline renders.
 *
 * Warnings never block care — they are advisory and always paired with a
 * plain-language rationale and a non-prescriptive disclaimer.
 *
 * Any change to INTERACTIONS must bump DRUG_INTERACTIONS_VERSION and be
 * signed off by a named clinical reviewer in the PR.
 */

export const DRUG_INTERACTIONS_VERSION = "2026-11-01.1";

export type InteractionSeverity = "major" | "moderate";

export type DrugInteractionRule = {
  id: string;
  /** Lower-case drug names / class names that identify the first side. */
  a: readonly string[];
  /** Lower-case drug names / class names that identify the second side. */
  b: readonly string[];
  severity: InteractionSeverity;
  /** Plain-language, non-prescriptive explanation for responders. */
  rationale: string;
  source: string;
};

export const INTERACTIONS: readonly DrugInteractionRule[] = [
  {
    id: "warfarin-nsaid",
    a: ["warfarin", "acenocoumarol"],
    b: ["ibuprofen", "diclofenac", "naproxen", "aspirin", "nsaid", "nsaids"],
    severity: "major",
    rationale:
      "Together these sharply raise the risk of serious bleeding, including in the stomach.",
    source:
      "Holbrook A et al. Evidence-based management of anticoagulant therapy. Chest. 2012;141(2 Suppl):e152S-e184S.",
  },
  {
    id: "warfarin-antiplatelet",
    a: ["warfarin", "acenocoumarol"],
    b: ["clopidogrel", "ticagrelor", "prasugrel"],
    severity: "major",
    rationale:
      "Two drugs that both slow clotting greatly increase bleeding risk.",
    source:
      "Holbrook A et al. Evidence-based management of anticoagulant therapy. Chest. 2012;141(2 Suppl):e152S-e184S.",
  },
  {
    id: "ssri-triptan",
    a: ["sertraline", "fluoxetine", "citalopram", "escitalopram", "paroxetine", "ssri"],
    b: ["sumatriptan", "rizatriptan", "triptan"],
    severity: "moderate",
    rationale:
      "Both raise serotonin; together they can cause serotonin syndrome (agitation, fever, tremor, fast heart rate).",
    source:
      "Boyer EW, Shannon M. The serotonin syndrome. N Engl J Med. 2005;352(11):1112-1120.",
  },
  {
    id: "ssri-tramadol",
    a: ["sertraline", "fluoxetine", "citalopram", "escitalopram", "paroxetine", "ssri"],
    b: ["tramadol"],
    severity: "major",
    rationale:
      "Both raise serotonin and lower the seizure threshold; together they can cause serotonin syndrome or seizures.",
    source:
      "Boyer EW, Shannon M. The serotonin syndrome. N Engl J Med. 2005;352(11):1112-1120.",
  },
  {
    id: "qt-prolongation",
    a: ["ondansetron", "haloperidol", "amiodarone", "methadone", "citalopram", "escitalopram"],
    b: ["ondansetron", "haloperidol", "amiodarone", "methadone", "citalopram", "escitalopram"],
    severity: "major",
    rationale:
      "Both can lengthen the heart's QT interval; together they raise the risk of a dangerous heart rhythm.",
    source:
      "CredibleMeds QTdrugs list, AZCERT. https://crediblemeds.org (accessed 2026-11-01).",
  },
  {
    id: "acei-potassium",
    a: ["lisinopril", "enalapril", "ramipril", "perindopril", "ace inhibitor"],
    b: ["spironolactone", "potassium chloride", "trimethoprim"],
    severity: "major",
    rationale:
      "Both raise blood potassium; together they can cause dangerously high potassium and heart rhythm problems.",
    source:
      "Palmer BF. Managing hyperkalemia caused by inhibitors of the renin-angiotensin-aldosterone system. N Engl J Med. 2004;351(6):585-592.",
  },
  {
    id: "insulin-sulfonylurea",
    a: ["insulin"],
    b: ["glibenclamide", "glyburide", "glimepiride", "gliclazide", "sulfonylurea"],
    severity: "moderate",
    rationale:
      "Two drugs that both lower blood sugar increase the risk of a severe low-sugar episode.",
    source:
      "Inzucchi SE et al. Management of hyperglycemia in type 2 diabetes, 2015. Diabetes Care. 2015;38(1):140-149.",
  },
  {
    id: "opioid-benzodiazepine",
    a: ["morphine", "codeine", "tramadol", "fentanyl", "oxycodone", "opioid"],
    b: ["diazepam", "lorazepam", "midazolam", "clonazepam", "benzodiazepine"],
    severity: "major",
    rationale:
      "Both slow breathing; together they can cause dangerous sedation and stopped breathing.",
    source:
      "FDA Drug Safety Communication: opioid pain medicines and benzodiazepines. 2016.",
  },
];

export const DRUG_INTERACTIONS_DISCLAIMER =
  "Advisory only: confirm with a clinician or pharmacist before changing any medicine. This is not a prescribing instruction.";

export type DrugInteractionWarning = {
  ruleId: string;
  severity: InteractionSeverity;
  /** The two recorded medication entries that triggered the rule. */
  medications: readonly [string, string];
  rationale: string;
};

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when a recorded medication entry names one of the rule's terms. */
function matches(entry: string, terms: readonly string[]): boolean {
  return terms.some(
    (term) => entry === term || entry.includes(term),
  );
}

/**
 * Returns interaction warnings for the given medication entries. Only
 * `major` and `moderate` rules are surfaced; each rule is reported once, with
 * the first pair of entries that triggered it.
 */
export function drugInteractionWarnings(
  medications: readonly string[],
  rules: readonly DrugInteractionRule[] = INTERACTIONS,
): DrugInteractionWarning[] {
  const entries = medications
    .map((raw) => ({ raw: raw.trim(), key: normalise(raw) }))
    .filter((entry) => entry.key.length > 0);

  const warnings: DrugInteractionWarning[] = [];
  for (const rule of rules) {
    let found: [string, string] | null = null;
    for (const first of entries) {
      if (!matches(first.key, rule.a)) continue;
      for (const second of entries) {
        if (second.key === first.key) continue;
        if (!matches(second.key, rule.b)) continue;
        found = [first.raw, second.raw];
        break;
      }
      if (found) break;
    }
    if (!found) continue;
    warnings.push({
      ruleId: rule.id,
      severity: rule.severity,
      medications: found,
      rationale: rule.rationale,
    });
  }
  return warnings;
}
