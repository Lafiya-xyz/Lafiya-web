import type { Genotype } from "@/lib/supabase/types";

/**
 * Issue #918: optional, patient-authored sickle-cell crisis care plan.
 *
 * Stored as a single JSON object on the emergency record (`sickle_cell_plan`)
 * so it travels with the governed revision, the emergency card RPC and the
 * patient export without a schema migration per field. Every field is
 * optional: a plan with no content is treated as absent.
 *
 * PENDING CLINICAL REVIEW: field set and the "prioritised for SS/SC" rule
 * below need sign-off before this is enabled for patients.
 */
export type SickleCellPlan = {
  /** Baseline haemoglobin in g/dL, e.g. "7.5". */
  baseline_hb: string | null;
  /** ISO date (YYYY-MM-DD) the baseline Hb was measured. */
  baseline_hb_date: string | null;
  /** Usual crisis analgesics with doses, one entry per line. */
  usual_analgesics: string[];
  /** ISO date (YYYY-MM-DD) of the last transfusion. */
  last_transfusion_date: string | null;
  /** Known red-cell alloantibodies. */
  known_alloantibodies: string[];
  hydroxyurea: {
    in_use: boolean;
    dose: string | null;
  };
  haematologist: {
    name: string | null;
    phone: string | null;
  };
  /** Who authored the plan; attestation is never inferred. */
  source: "patient" | "clinician";
  /** ISO date the plan was last reviewed/attested, if any. */
  attested_at: string | null;
};

export const EMPTY_SICKLE_CELL_PLAN: SickleCellPlan = {
  baseline_hb: null,
  baseline_hb_date: null,
  usual_analgesics: [],
  last_transfusion_date: null,
  known_alloantibodies: [],
  hydroxyurea: { in_use: false, dose: null },
  haematologist: { name: null, phone: null },
  source: "patient",
  attested_at: null,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HB_PATTERN = /^\d{1,2}(\.\d{1,2})?$/;

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFC").trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
};

const isoDate = (value: unknown): string | null => {
  const trimmed = text(value);
  if (!trimmed || !ISO_DATE.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : trimmed;
};

const list = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => text(item))
        .filter((item): item is string => item !== null),
    ),
  ];
};

/** Parses untrusted JSON (form input, stored revision) into a plan. */
export function parseSickleCellPlan(value: unknown): SickleCellPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_SICKLE_CELL_PLAN;
  }
  const raw = value as Record<string, unknown>;
  const hydroxyurea =
    raw.hydroxyurea && typeof raw.hydroxyurea === "object"
      ? (raw.hydroxyurea as Record<string, unknown>)
      : {};
  const haematologist =
    raw.haematologist && typeof raw.haematologist === "object"
      ? (raw.haematologist as Record<string, unknown>)
      : {};
  const hb = text(raw.baseline_hb);

  return {
    baseline_hb: hb && HB_PATTERN.test(hb) ? hb : null,
    baseline_hb_date: isoDate(raw.baseline_hb_date),
    usual_analgesics: list(raw.usual_analgesics),
    last_transfusion_date: isoDate(raw.last_transfusion_date),
    known_alloantibodies: list(raw.known_alloantibodies),
    hydroxyurea: {
      in_use: hydroxyurea.in_use === true,
      dose: text(hydroxyurea.dose),
    },
    haematologist: {
      name: text(haematologist.name),
      phone: text(haematologist.phone),
    },
    source: raw.source === "clinician" ? "clinician" : "patient",
    attested_at: isoDate(raw.attested_at),
  };
}

/** True when the plan carries no clinical content at all. */
export function isSickleCellPlanEmpty(plan: SickleCellPlan): boolean {
  return (
    plan.baseline_hb === null &&
    plan.baseline_hb_date === null &&
    plan.usual_analgesics.length === 0 &&
    plan.last_transfusion_date === null &&
    plan.known_alloantibodies.length === 0 &&
    !plan.hydroxyurea.in_use &&
    plan.hydroxyurea.dose === null &&
    plan.haematologist.name === null &&
    plan.haematologist.phone === null
  );
}

/**
 * SS and SC genotypes carry the highest crisis risk, so the plan is rendered
 * above the rest of the card for them (issue #918 acceptance criterion).
 */
export function isSickleCellGenotype(genotype: Genotype | null): boolean {
  return genotype === "SS" || genotype === "SC";
}

/** Human-readable attestation status shown next to the plan. */
export function sickleCellPlanStatus(plan: SickleCellPlan): string {
  if (plan.source === "clinician" && plan.attested_at) {
    return `Clinician-attested on ${plan.attested_at}`;
  }
  if (plan.source === "clinician") return "Clinician-authored";
  return "Patient-reported — not clinician-attested";
}
