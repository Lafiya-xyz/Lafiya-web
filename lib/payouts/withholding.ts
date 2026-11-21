/**
 * CHW payout withholding-tax rules engine (issue #910).
 *
 * Pure, dependency-free so it can be unit-tested per rule and reused by the
 * payout indexer, the remittance scheduler and the ledger writer.
 *
 * Rules are per jurisdiction and carry an effective window. A payout is taxed
 * by the single rule effective at the payout instant; overlapping windows for
 * the same jurisdiction are a configuration error and fail closed (same
 * governance stance as `resolveRateCard` in lib/chw-protocol/config.ts).
 *
 * Money is handled in integer micro-USDC (1 USDC = 1_000_000) so rounding is
 * deterministic and the ledger stays balanced: the withheld amount is always
 * `gross - net`, never a separately rounded figure.
 */

export const MICRO_USDC = 1_000_000;

export type WithholdingRule = {
  id: string;
  /** ISO 3166-1 alpha-2 jurisdiction code, upper-case. */
  jurisdiction: string;
  /** Rate in basis points (1 bp = 0.01%). 0..10_000. */
  rateBps: number;
  /** Gross amount (micro-USDC) below which no tax is withheld. */
  thresholdMicro: number;
  /** Inclusive start of the rule's effective window. */
  effectiveFrom: Date;
  /** Exclusive end of the rule's effective window; null = open-ended. */
  effectiveTo: Date | null;
};

export type WithholdingResult = {
  ruleId: string;
  jurisdiction: string;
  grossMicro: number;
  withheldMicro: number;
  netMicro: number;
  rateBps: number;
};

export class WithholdingConfigError extends Error {
  constructor(readonly code: string) {
    super(`WITHHOLDING_CONFIG_INVALID:${code}`);
    this.name = "WithholdingConfigError";
  }
}

export class WithholdingRuleError extends Error {
  constructor(readonly code: string) {
    super(`WITHHOLDING_RULE_ERROR:${code}`);
    this.name = "WithholdingRuleError";
  }
}

function assertRule(rule: WithholdingRule): void {
  if (!/^[A-Z]{2}$/.test(rule.jurisdiction)) {
    throw new WithholdingConfigError("JURISDICTION_INVALID");
  }
  if (!Number.isInteger(rule.rateBps) || rule.rateBps < 0 || rule.rateBps > 10_000) {
    throw new WithholdingConfigError("RATE_OUT_OF_RANGE");
  }
  if (!Number.isInteger(rule.thresholdMicro) || rule.thresholdMicro < 0) {
    throw new WithholdingConfigError("THRESHOLD_INVALID");
  }
  if (Number.isNaN(rule.effectiveFrom.getTime())) {
    throw new WithholdingConfigError("EFFECTIVE_FROM_INVALID");
  }
  if (rule.effectiveTo && rule.effectiveTo.getTime() <= rule.effectiveFrom.getTime()) {
    throw new WithholdingConfigError("EFFECTIVE_WINDOW_INVALID");
  }
}

/**
 * Validates a rule set at startup: every rule is well-formed and no two rules
 * for the same jurisdiction have overlapping effective windows.
 */
export function validateWithholdingRules(rules: readonly WithholdingRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    assertRule(rule);
    if (seen.has(rule.id)) throw new WithholdingConfigError("DUPLICATE_RULE_ID");
    seen.add(rule.id);
  }
  const byJurisdiction = new Map<string, WithholdingRule[]>();
  for (const rule of rules) {
    const list = byJurisdiction.get(rule.jurisdiction) ?? [];
    list.push(rule);
    byJurisdiction.set(rule.jurisdiction, list);
  }
  for (const list of byJurisdiction.values()) {
    const sorted = [...list].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    );
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      const previousEnd = previous.effectiveTo?.getTime() ?? Infinity;
      if (current.effectiveFrom.getTime() < previousEnd) {
        throw new WithholdingConfigError("OVERLAPPING_EFFECTIVE_WINDOWS");
      }
    }
  }
}

/** The single rule effective for a jurisdiction at `at`, or null. */
export function resolveWithholdingRule(
  rules: readonly WithholdingRule[],
  jurisdiction: string,
  at: Date,
): WithholdingRule | null {
  const matches = rules.filter(
    (rule) =>
      rule.jurisdiction === jurisdiction &&
      rule.effectiveFrom.getTime() <= at.getTime() &&
      (rule.effectiveTo === null || at.getTime() < rule.effectiveTo.getTime()),
  );
  if (matches.length > 1) {
    throw new WithholdingConfigError("AMBIGUOUS_ACTIVE_RULE");
  }
  return matches[0] ?? null;
}

/**
 * Computes withholding for one payout. Withholding is rounded down to the
 * micro-USDC so the CHW is never under-paid by rounding; `net + withheld`
 * always equals `gross`.
 */
export function computeWithholding(
  rules: readonly WithholdingRule[],
  input: { jurisdiction: string; grossMicro: number; at: Date },
): WithholdingResult {
  if (!Number.isInteger(input.grossMicro) || input.grossMicro < 0) {
    throw new WithholdingRuleError("GROSS_INVALID");
  }
  const rule = resolveWithholdingRule(rules, input.jurisdiction, input.at);
  if (!rule) throw new WithholdingRuleError("NO_ACTIVE_RULE");

  const taxable = Math.max(0, input.grossMicro - rule.thresholdMicro);
  const withheldMicro = Math.floor((taxable * rule.rateBps) / 10_000);
  return {
    ruleId: rule.id,
    jurisdiction: rule.jurisdiction,
    grossMicro: input.grossMicro,
    withheldMicro,
    netMicro: input.grossMicro - withheldMicro,
    rateBps: rule.rateBps,
  };
}

export type LedgerEntry = {
  account: "chw_payable" | "withholding_payable" | "payout_expense";
  direction: "debit" | "credit";
  amountMicro: number;
};

/**
 * Double-entry lines for one payout: expense is debited for the gross, the CHW
 * payable is credited the net and the tax authority payable the withheld
 * amount. Sum of debits equals sum of credits by construction.
 */
export function withholdingLedgerEntries(result: WithholdingResult): LedgerEntry[] {
  const entries: LedgerEntry[] = [
    { account: "payout_expense", direction: "debit", amountMicro: result.grossMicro },
    { account: "chw_payable", direction: "credit", amountMicro: result.netMicro },
  ];
  if (result.withheldMicro > 0) {
    entries.push({
      account: "withholding_payable",
      direction: "credit",
      amountMicro: result.withheldMicro,
    });
  }
  return entries;
}

export function isLedgerBalanced(entries: readonly LedgerEntry[]): boolean {
  let debits = 0;
  let credits = 0;
  for (const entry of entries) {
    if (entry.direction === "debit") debits += entry.amountMicro;
    else credits += entry.amountMicro;
  }
  return debits === credits;
}

/** `YYYY-MM` remittance period for a payout instant (UTC). */
export function remittancePeriod(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type RemittanceLine = {
  payoutId: string;
  chwId: string;
  jurisdiction: string;
  ruleId: string;
  grossMicro: number;
  withheldMicro: number;
  netMicro: number;
  paidAt: Date;
};

export type RemittanceSchedule = {
  period: string;
  jurisdiction: string;
  lines: RemittanceLine[];
  grossMicro: number;
  withheldMicro: number;
  netMicro: number;
};

/** Groups payout lines into one monthly schedule per jurisdiction. */
export function buildRemittanceSchedules(
  lines: readonly RemittanceLine[],
): RemittanceSchedule[] {
  const byKey = new Map<string, RemittanceSchedule>();
  for (const line of lines) {
    const period = remittancePeriod(line.paidAt);
    const key = `${period}:${line.jurisdiction}`;
    let schedule = byKey.get(key);
    if (!schedule) {
      schedule = {
        period,
        jurisdiction: line.jurisdiction,
        lines: [],
        grossMicro: 0,
        withheldMicro: 0,
        netMicro: 0,
      };
      byKey.set(key, schedule);
    }
    schedule.lines.push(line);
    schedule.grossMicro += line.grossMicro;
    schedule.withheldMicro += line.withheldMicro;
    schedule.netMicro += line.netMicro;
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.period.localeCompare(b.period) ||
      a.jurisdiction.localeCompare(b.jurisdiction),
  );
}

const CSV_HEADER = [
  "period",
  "jurisdiction",
  "payout_id",
  "chw_id",
  "rule_id",
  "gross_usdc",
  "withheld_usdc",
  "net_usdc",
  "paid_at",
] as const;

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function usdc(micro: number): string {
  return (micro / MICRO_USDC).toFixed(7);
}

/** Deterministic CSV rendering of a remittance schedule. */
export function remittanceScheduleCsv(schedule: RemittanceSchedule): string {
  const rows = [CSV_HEADER.join(",")];
  for (const line of schedule.lines) {
    rows.push(
      [
        schedule.period,
        schedule.jurisdiction,
        line.payoutId,
        line.chwId,
        line.ruleId,
        usdc(line.grossMicro),
        usdc(line.withheldMicro),
        usdc(line.netMicro),
        line.paidAt.toISOString(),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}
