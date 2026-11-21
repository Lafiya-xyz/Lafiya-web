/**
 * Issue #920: recent key lab results.
 *
 * A small, closed set of clinically important analytes (haemoglobin, HbA1c,
 * creatinine/eGFR, HIV viral load) recorded with LOINC codes, canonical units,
 * reference ranges, collection date and source. Pure and deterministic: no
 * network calls, safe for offline renders and FHIR export.
 *
 * Sensitive analytes (HIV viral load) are private by default and are only
 * disclosed when the owner explicitly opts in per result.
 *
 * Any change to LAB_ANALYTES must bump LAB_RESULTS_VERSION and be signed off
 * by a named clinical reviewer in the PR.
 */

export const LAB_RESULTS_VERSION = "2026-11-01.1";

export type LabAnalyteId =
  | "hemoglobin"
  | "hba1c"
  | "creatinine"
  | "egfr"
  | "hiv_viral_load";

export type LabUnit = "g/dL" | "g/L" | "%" | "mg/dL" | "umol/L" | "mL/min/1.73m2" | "copies/mL";

export type LabAnalyte = {
  id: LabAnalyteId;
  label: string;
  loinc: string;
  /** Canonical unit every stored value is normalized to. */
  canonicalUnit: LabUnit;
  /** Accepted input units and their factor to the canonical unit. */
  units: Partial<Record<LabUnit, number>>;
  /** Plausible range in canonical units; outside is a data-entry error. */
  plausible: { min: number; max: number };
  /** Default adult reference range in canonical units. */
  referenceRange: { low: number; high: number } | null;
  /** Results older than this are flagged stale. */
  staleAfterDays: number;
  /** Sensitive analytes are private by default and never public without opt-in. */
  sensitive: boolean;
};

export const LAB_ANALYTES: Readonly<Record<LabAnalyteId, LabAnalyte>> = {
  hemoglobin: {
    id: "hemoglobin",
    label: "Haemoglobin",
    loinc: "718-7",
    canonicalUnit: "g/dL",
    units: { "g/dL": 1, "g/L": 0.1 },
    plausible: { min: 2, max: 25 },
    referenceRange: { low: 12, high: 17.5 },
    staleAfterDays: 180,
    sensitive: false,
  },
  hba1c: {
    id: "hba1c",
    label: "HbA1c",
    loinc: "4548-4",
    canonicalUnit: "%",
    units: { "%": 1 },
    plausible: { min: 3, max: 20 },
    referenceRange: { low: 4, high: 5.6 },
    staleAfterDays: 180,
    sensitive: false,
  },
  creatinine: {
    id: "creatinine",
    label: "Creatinine",
    loinc: "2160-0",
    canonicalUnit: "mg/dL",
    units: { "mg/dL": 1, "umol/L": 1 / 88.4 },
    plausible: { min: 0.1, max: 20 },
    referenceRange: { low: 0.6, high: 1.3 },
    staleAfterDays: 365,
    sensitive: false,
  },
  egfr: {
    id: "egfr",
    label: "eGFR",
    loinc: "33914-3",
    canonicalUnit: "mL/min/1.73m2",
    units: { "mL/min/1.73m2": 1 },
    plausible: { min: 1, max: 200 },
    referenceRange: { low: 90, high: 200 },
    staleAfterDays: 365,
    sensitive: false,
  },
  hiv_viral_load: {
    id: "hiv_viral_load",
    label: "HIV viral load",
    loinc: "20447-9",
    canonicalUnit: "copies/mL",
    units: { "copies/mL": 1 },
    plausible: { min: 0, max: 10_000_000 },
    referenceRange: null,
    staleAfterDays: 365,
    sensitive: true,
  },
};

export const LAB_ANALYTE_IDS = Object.keys(LAB_ANALYTES) as LabAnalyteId[];

export type LabSource = "self_reported" | "clinic" | "lab_report" | "chw";

export const LAB_SOURCES: readonly LabSource[] = [
  "self_reported",
  "clinic",
  "lab_report",
  "chw",
];

export type LabResultInput = {
  analyte: LabAnalyteId;
  value: number;
  unit: string;
  collectedAt: string;
  source: LabSource;
  /** Owner opt-in required before a sensitive result may be disclosed. */
  sharePublicly?: boolean;
};

export type LabResult = {
  analyte: LabAnalyteId;
  label: string;
  loinc: string;
  value: number;
  unit: LabUnit;
  collectedAt: string;
  source: LabSource;
  referenceRange: { low: number; high: number } | null;
  /** "low" | "normal" | "high" against the reference range, null if none. */
  interpretation: "low" | "normal" | "high" | null;
  sensitive: boolean;
  sharePublicly: boolean;
};

export type LabResultError =
  | "unknown_analyte"
  | "unsupported_unit"
  | "invalid_value"
  | "implausible_value"
  | "invalid_date"
  | "future_date"
  | "invalid_source";

export type LabResultValidation =
  | { ok: true; result: LabResult }
  | { ok: false; error: LabResultError };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function interpret(
  value: number,
  range: { low: number; high: number } | null,
): LabResult["interpretation"] {
  if (!range) return null;
  if (value < range.low) return "low";
  if (value > range.high) return "high";
  return "normal";
}

/**
 * Validates and normalizes one lab result. Values are converted to the
 * analyte's canonical unit; sensitive analytes default to private.
 */
export function validateLabResult(
  input: LabResultInput,
  now: Date = new Date(),
): LabResultValidation {
  const analyte = LAB_ANALYTES[input.analyte];
  if (!analyte) return { ok: false, error: "unknown_analyte" };

  const factor = analyte.units[input.unit as LabUnit];
  if (factor === undefined) return { ok: false, error: "unsupported_unit" };

  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return { ok: false, error: "invalid_value" };
  }

  const value = round(input.value * factor, 3);
  if (input.value < 0 || value < analyte.plausible.min || value > analyte.plausible.max) {
    return { ok: false, error: "implausible_value" };
  }

  const collectedMs = ISO_DATE.test(input.collectedAt)
    ? Date.parse(`${input.collectedAt}T00:00:00Z`)
    : Number.NaN;
  if (Number.isNaN(collectedMs)) {
    return { ok: false, error: "invalid_date" };
  }
  if (collectedMs > now.getTime()) {
    return { ok: false, error: "future_date" };
  }

  if (!LAB_SOURCES.includes(input.source)) {
    return { ok: false, error: "invalid_source" };
  }

  return {
    ok: true,
    result: {
      analyte: analyte.id,
      label: analyte.label,
      loinc: analyte.loinc,
      value,
      unit: analyte.canonicalUnit,
      collectedAt: input.collectedAt,
      source: input.source,
      referenceRange: analyte.referenceRange,
      interpretation: interpret(value, analyte.referenceRange),
      sensitive: analyte.sensitive,
      // Sensitive results are private unless the owner explicitly opts in.
      sharePublicly: analyte.sensitive ? input.sharePublicly === true : true,
    },
  };
}

/** True when a result is older than its analyte's staleness window. */
export function isStale(result: Pick<LabResult, "analyte" | "collectedAt">, now: Date = new Date()): boolean {
  const analyte = LAB_ANALYTES[result.analyte];
  if (!analyte) return true;
  const ageMs = now.getTime() - Date.parse(`${result.collectedAt}T00:00:00Z`);
  return ageMs > analyte.staleAfterDays * 24 * 60 * 60 * 1000;
}

/**
 * Results that may be shown on a public/emergency surface: sensitive results
 * only when the owner opted in, and never stale ones.
 */
export function publicLabResults(results: LabResult[], now: Date = new Date()): LabResult[] {
  return results.filter(
    (result) => (!result.sensitive || result.sharePublicly) && !isStale(result, now),
  );
}

/** FHIR R4 `Observation` for one lab result (see docs/fhir-mapping.md). */
export function toFhirObservation(
  result: LabResult,
  subjectReference: string,
): Record<string, unknown> {
  return {
    resourceType: "Observation",
    status: "final",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory",
            display: "Laboratory",
          },
        ],
      },
    ],
    code: {
      coding: [{ system: "http://loinc.org", code: result.loinc, display: result.label }],
      text: result.label,
    },
    subject: { reference: subjectReference },
    effectiveDateTime: result.collectedAt,
    valueQuantity: {
      value: result.value,
      unit: result.unit,
      system: "http://unitsofmeasure.org",
      code: result.unit,
    },
    ...(result.referenceRange
      ? {
          referenceRange: [
            {
              low: { value: result.referenceRange.low, unit: result.unit },
              high: { value: result.referenceRange.high, unit: result.unit },
            },
          ],
        }
      : {}),
    ...(result.interpretation
      ? {
          interpretation: [
            {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                  code: result.interpretation === "normal" ? "N" : result.interpretation === "low" ? "L" : "H",
                },
              ],
            },
          ],
        }
      : {}),
    note: [{ text: `Source: ${result.source}` }],
  };
}
