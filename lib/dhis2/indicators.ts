/**
 * Issue #935: DHIS2 aggregate programme indicators.
 *
 * Pure, dependency-free core of the DHIS2 reporting pipeline:
 *   1. `aggregateIndicatorCells` turns per-organization enrollment counts into
 *      DHIS2 dataValue cells (dataElement + categoryOptionCombo + period).
 *   2. `suppressSmallCells` drops every cell whose count is below the
 *      small-cell threshold. Suppressed cells are *removed*, never zeroed or
 *      masked, so they can never be transmitted by a later step.
 *   3. `buildDataValueSet` renders the idempotent `dataValueSets` payload.
 *
 * Privacy: only aggregate counts keyed by DHIS2 identifiers are handled here.
 * No patient identifiers, names, phone numbers or capability tokens ever enter
 * this module, and nothing in it logs.
 */

/** Minimum count a cell must reach to be reported (small-cell suppression). */
export const DEFAULT_SUPPRESSION_THRESHOLD = 5;

/** DHIS2 period types this module can emit. */
export type Dhis2PeriodType = "Monthly" | "Quarterly" | "Yearly";

export interface Dhis2IndicatorMapping {
  /** Stable mapping id (also used as the idempotency key component). */
  id: string;
  /** DHIS2 data element UID (11 chars, alphanumeric). */
  dataElement: string;
  /** DHIS2 category option combo UID. */
  categoryOptionCombo: string;
  /** Which aggregate counter feeds this data element. */
  metric: Dhis2Metric;
  /** Optional per-mapping override of the small-cell threshold. */
  suppressionThreshold?: number;
}

export type Dhis2Metric =
  | "enrollments"
  | "verified_enrollments"
  | "active_chws"
  | "verification_visits";

export interface EnrollmentAggregateRow {
  /** Organization (partner) the counts belong to. */
  organizationId: string;
  metric: Dhis2Metric;
  count: number;
}

new

export interface SuppressionSummary {
  /** Cells dropped because their count was below the threshold. */
  suppressedCells: number;
  /** Cells emitted in the payload. */
  transmittedCells: number;
}

export interface DataValueSet {
  dataSet: string;
  period: string;
  orgUnit: string;
  completeDate?: string;
  dataValues: Dhis2DataValue[];
}

const UID_PATTERN = /^[A-Za-z][A-Za-z0-9]{10}$/;

export function isValidDhis2Uid(value: string): boolean {
  return UID_PATTERN.test(value);
}

/** `YYYY-MM` -> `YYYYMM` (DHIS2 Monthly period). */
export function toDhis2Period(period: string, type: Dhis2PeriodType = "Monthly"): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`period must be YYYY-MM, got ${period}`);
  const [, year, month] = match;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) throw new Error(`invalid month in period ${period}`);
  if (type === "Monthly") return `${year}${month}`;
  if (type === "Quarterly") return `${year}Q${Math.ceil(monthNumber / 3)}`;
  return year;
}

/**
 * Join aggregate rows with the organization's mappings. Rows without a
 * mapping are ignored (an unmapped metric is simply not reported).
 */
export function aggregateIndicatorCells(
  rows: EnrollmentAggregateRow[],
  mappings: Dhis2IndicatorMapping[],
  period: string,
  orgUnit: string,
): Dhis2DataValue[] {
  const byMetric = new Map<Dhis2Metric, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.count) || row.count < 0) continue;
    byMetric.set(row.metric, (byMetric.get(row.metric) ?? 0) + Math.trunc(row.count));
  }

  const cells: Dhis2DataValue[] = [];
  for (const mapping of mappings) {
    const count = byMetric.get(mapping.metric);
    if (count === undefined) continue;
    cells.push({
      dataElement: mapping.dataElement,
      categoryOptionCombo: mapping.categoryOptionCombo,
      period,
      orgUnit,
      value: String(count),
    });
  }
  return cells;
}

/**
 * Remove every cell whose value is below the applicable threshold. The
 * threshold is the mapping override when present, else the default. Cells
 * with a non-numeric value are dropped too (fail closed).
 */
export function suppressSmallCells(
  cells: Dhis2DataValue[],
  mappings: Dhis2IndicatorMapping[],
  defaultThreshold: number = DEFAULT_SUPPRESSION_THRESHOLD,
): { cells: Dhis2DataValue[]; summary: SuppressionSummary } {
  const thresholdByElement = new Map<string, number>();
  for (const mapping of mappings) {
    thresholdByElement.set(
      `${mapping.dataElement}|${mapping.categoryOptionCombo}`,
      mapping.suppressionThreshold ?? defaultThreshold,
    );
  }

  const kept: Dhis2DataValue[] = [];
  let suppressedCells = 0;
  for (const cell of cells) {
    const threshold =
      thresholdByElement.get(`${cell.dataElement}|${cell.categoryOptionCombo}`) ?? defaultThreshold;
    const value = Number(cell.value);
    if (!Number.isFinite(value) || value < threshold) {
      suppressedCells += 1;
      continue;
    }
    kept.push(cell);
  }
  return { cells: kept, summary: { suppressedCells, transmittedCells: kept.length } };
}

/**
 * Build the `dataValueSets` payload. `dataValues` is sorted by
 * dataElement/categoryOptionCombo so the same inputs always produce
 * byte-identical JSON — that is what makes the import idempotent on DHIS2's
 * side (re-posting an identical set is a no-op update, not a duplicate).
 */
export function buildDataValueSet(input: {
  dataSet: string;
  period: string;
  orgUnit: string;
  cells: Dhis2DataValue[];
  completeDate?: string;
}): DataValueSet {
  const dataValues = [...input.cells].sort((a, b) =>
    `${a.dataElement}|${a.categoryOptionCombo}`.localeCompare(
      `${b.dataElement}|${b.categoryOptionCombo}`,
    ),
  );
  return {
    dataSet: input.dataSet,
    period: input.period,
    orgUnit: input.orgUnit,
    ...(input.completeDate ? { completeDate: input.completeDate } : {}),
    dataValues,
  };
}

/** Deterministic idempotency key for one organization/period import. */
export function importIdempotencyKey(organizationId: string, period: string): string {
  return `dhis2:${organizationId}:${period}`;
}
