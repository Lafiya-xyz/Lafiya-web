/**
 * Funder sub-pools and the deterministic payout allocation engine (issue #907).
 *
 * A funder sub-pool is a restricted grant: a Stellar sponsor account plus
 * eligibility rules (regions, programmes, date range, max per CHW) and a
 * priority. Every payout obligation is routed to exactly one pool by
 * `allocatePayout`, which is a pure function of its inputs:
 *
 *  - candidate pools are those whose rules the payout satisfies (ineligible
 *    payouts are never charged to a restricted pool),
 *  - candidates are ordered by priority (ascending, lower wins), then by
 *    expiry (expiring funds first), then by pool id (ASCII) so ties are
 *    stable,
 *  - a pool is skipped when its remaining balance cannot cover the amount or
 *    when the CHW has already reached the pool's per-CHW cap,
 *  - the first pool that fits is charged; if none fits the payout is
 *    `unallocated` and must not be paid from a restricted pool.
 *
 * All amounts are stroops (1 USDC = 10^7 stroops) held as `bigint`, so
 * allocation and reconciliation are exact to the cent and never touch
 * floating point. Re-running the engine over the same inputs (in any order)
 * produces byte-identical output -- see `serializeAllocation`.
 */

export const STROOPS_PER_USDC = 10_000_000n;

/** Converts a fixed-decimal USDC string ("12.5000000") to stroops. */
export function usdcToStroops(amountUsdc: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,7}))?$/.exec(amountUsdc.trim());
  if (!match) {
    throw new Error(`invalid USDC amount: ${amountUsdc}`);
  }
  const [, sign, whole, frac = ""] = match;
  const fracPadded = (frac + "0000000").slice(0, 7);
  const stroops = BigInt(whole) * STROOPS_PER_USDC + BigInt(fracPadded);
  return sign === "-" ? -stroops : stroops;
}

/** Formats stroops as a fixed 7-decimal USDC string. */
export function stroopsToUsdc(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_USDC;
  const frac = (abs % STROOPS_PER_USDC).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export interface FunderPoolRules {
  /** Allowed regions; `null` means any region. */
  regions: string[] | null;
  /** Allowed programme codes; `null` means any programme. */
  programmes: string[] | null;
  /** Inclusive UTC start of the funding window; `null` means unbounded. */
  startsAt: string | null;
  /** Inclusive UTC end of the funding window; `null` means unbounded. */
  endsAt: string | null;
  /** Maximum stroops a single CHW may receive from this pool; `null` = no cap. */
  maxPerChwStroops: bigint | null;
}

export interface FunderPool {
  id: string;
  funderName: string;
  /** Stellar sponsor account the pool pays from. */
  sponsorPool: string;
  /** Lower number = higher priority. */
  priority: number;
  /** ISO timestamp after which unspent funds are returned; `null` = never. */
  expiresAt: string | null;
  /** Total earmarked stroops. */
  fundedStroops: bigint;
  /** Stroops already charged to this pool (ledger sum). */
  spentStroops: bigint;
  rules: FunderPoolRules;
}

export interface PayoutRequest {
  obligationId: string;
  chwId: string;
  region: string | null;
  programme: string | null;
  /** ISO timestamp the payout is attributed to (obligation creation). */
  occurredAt: string;
  amountStroops: bigint;
}

export type AllocationReasonCode =
  | "allocated"
  | "no_eligible_pool"
  | "insufficient_pool_balance"
  | "per_chw_cap_reached";

export interface PoolEvaluation {
  poolId: string;
  eligible: boolean;
  /** Why the pool was not charged, when it was not. */
  reason: AllocationReasonCode | null;
  remainingStroops: bigint;
  chwSpentStroops: bigint;
}

export interface AllocationDecision {
  obligationId: string;
  amountStroops: bigint;
  /** Charged pool id, or `null` when nothing could be charged. */
  poolId: string | null;
  reason: AllocationReasonCode;
  /** Every candidate pool considered, in evaluation order (explainability). */
  evaluations: PoolEvaluation[];
}

export interface AllocationInput {
  pools: FunderPool[];
  payouts: PayoutRequest[];
  /** Stroops already charged per pool per CHW (from the pool ledger). */
  chwSpentByPool?: Record<string, Record<string, bigint>>;
}

export interface AllocationResult {
  decisions: AllocationDecision[];
  /** Post-allocation balances per pool id. */
  balances: Record<string, bigint>;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function withinWindow(pool: FunderPool, occurredAt: string): boolean {
  const at = Date.parse(occurredAt);
  if (Number.isNaN(at)) {
    throw new Error(`invalid occurredAt: ${occurredAt}`);
  }
  if (pool.rules.startsAt !== null && at < Date.parse(pool.rules.startsAt)) return false;
  if (pool.rules.endsAt !== null && at > Date.parse(pool.rules.endsAt)) return false;
  return true;
}

function matchesRules(pool: FunderPool, payout: PayoutRequest): boolean {
  const { regions, programmes } = pool.rules;
  if (regions !== null && (payout.region === null || !regions.includes(payout.region))) {
    return false;
  }
  if (programmes !== null && (payout.programme === null || !programmes.includes(payout.programme))) {
    return false;
  }
  return withinWindow(pool, payout.occurredAt);
}

/** Deterministic candidate ordering: priority, then expiry (soonest first), then id. */
function comparePools(a: FunderPool, b: FunderPool): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const aExpiry = a.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.expiresAt);
  const bExpiry = b.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.expiresAt);
  if (aExpiry !== bExpiry) return aExpiry < bExpiry ? -1 : 1;
  return compareStrings(a.id, b.id);
}

/**
 * Routes each payout to a pool. Payouts are processed in a canonical order
 * (occurredAt, then obligationId) so the result does not depend on input
 * order; decisions are returned in that same canonical order.
 */
export function allocatePayouts(input: AllocationInput): AllocationResult {
  const balances = new Map<string, bigint>();
  const chwSpent = new Map<string, Map<string, bigint>>();
  for (const pool of input.pools) {
    if (balances.has(pool.id)) {
      throw new Error(`duplicate pool id: ${pool.id}`);
    }
    balances.set(pool.id, pool.fundedStroops - pool.spentStroops);
    const perChw = new Map<string, bigint>();
    for (const [chwId, spent] of Object.entries(input.chwSpentByPool?.[pool.id] ?? {})) {
      perChw.set(chwId, spent);
    }
    chwSpent.set(pool.id, perChw);
  }

  const ordered = [...input.pools].sort(comparePools);
  const payouts = [...input.payouts].sort((a, b) => {
    const at = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
    return at !== 0 ? at : compareStrings(a.obligationId, b.obligationId);
  });

  const decisions: AllocationDecision[] = [];
  for (const payout of payouts) {
    if (payout.amountStroops < 0n) {
      throw new Error(`negative payout amount for obligation ${payout.obligationId}`);
    }

    const evaluations: PoolEvaluation[] = [];
    let chargedPoolId: string | null = null;
    let reason: AllocationReasonCode = "no_eligible_pool";

    for (const pool of ordered) {
      const remaining = balances.get(pool.id) as bigint;
      const perChw = chwSpent.get(pool.id) as Map<string, bigint>;
      const chwSpentStroops = perChw.get(payout.chwId) ?? 0n;

      if (!matchesRules(pool, payout)) {
        evaluations.push({
          poolId: pool.id,
          eligible: false,
          reason: null,
          remainingStroops: remaining,
          chwSpentStroops,
        });
        continue;
      }

      const cap = pool.rules.maxPerChwStroops;
      if (cap !== null && chwSpentStroops + payout.amountStroops > cap) {
        evaluations.push({
          poolId: pool.id,
          eligible: true,
          reason: "per_chw_cap_reached",
          remainingStroops: remaining,
          chwSpentStroops,
        });
        if (reason === "no_eligible_pool") reason = "per_chw_cap_reached";
        continue;
      }

      if (remaining < payout.amountStroops) {
        evaluations.push({
          poolId: pool.id,
          eligible: true,
          reason: "insufficient_pool_balance",
          remainingStroops: remaining,
          chwSpentStroops,
        });
        if (reason === "no_eligible_pool") reason = "insufficient_pool_balance";
        continue;
      }

      evaluations.push({
        poolId: pool.id,
        eligible: true,
        reason: "allocated",
        remainingStroops: remaining,
        chwSpentStroops,
      });
      balances.set(pool.id, remaining - payout.amountStroops);
      perChw.set(payout.chwId, chwSpentStroops + payout.amountStroops);
      chargedPoolId = pool.id;
      reason = "allocated";
      break;
    }

    decisions.push({
      obligationId: payout.obligationId,
      amountStroops: payout.amountStroops,
      poolId: chargedPoolId,
      reason,
      evaluations,
    });
  }

  const finalBalances: Record<string, bigint> = {};
  for (const pool of [...input.pools].sort((a, b) => compareStrings(a.id, b.id))) {
    const balance = balances.get(pool.id) as bigint;
    if (balance < 0n) {
      throw new Error(`pool ${pool.id} would go negative`);
    }
    finalBalances[pool.id] = balance;
  }

  return { decisions, balances: finalBalances };
}

/** Stable JSON form of an allocation result, used for reproducibility checks. */
export function serializeAllocation(result: AllocationResult): string {
  return JSON.stringify({
    decisions: result.decisions.map((decision) => ({
      obligationId: decision.obligationId,
      amountStroops: decision.amountStroops.toString(),
      poolId: decision.poolId,
      reason: decision.reason,
      evaluations: decision.evaluations.map((evaluation) => ({
        poolId: evaluation.poolId,
        eligible: evaluation.eligible,
        reason: evaluation.reason,
        remainingStroops: evaluation.remainingStroops.toString(),
        chwSpentStroops: evaluation.chwSpentStroops.toString(),
      })),
    })),
    balances: Object.keys(result.balances)
      .sort(compareStrings)
      .map((poolId) => [poolId, result.balances[poolId].toString()]),
  });
}

export interface PoolUsageRow {
  poolId: string;
  funderName: string;
  fundedStroops: bigint;
  spentStroops: bigint;
  remainingStroops: bigint;
  payoutsCount: number;
}

/**
 * Per-pool usage for funder reports. Reconciles to the stroop: the sum of
 * `spentStroops` across pools equals the sum of allocated decision amounts.
 */
export function buildPoolUsage(
  pools: FunderPool[],
  decisions: AllocationDecision[],
): PoolUsageRow[] {
  const spent = new Map<string, bigint>();
  const counts = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.poolId === null) continue;
    spent.set(decision.poolId, (spent.get(decision.poolId) ?? 0n) + decision.amountStroops);
    counts.set(decision.poolId, (counts.get(decision.poolId) ?? 0) + 1);
  }

  return [...pools]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((pool) => {
      const poolSpent = pool.spentStroops + (spent.get(pool.id) ?? 0n);
      return {
        poolId: pool.id,
        funderName: pool.funderName,
        fundedStroops: pool.fundedStroops,
        spentStroops: poolSpent,
        remainingStroops: pool.fundedStroops - poolSpent,
        payoutsCount: counts.get(pool.id) ?? 0,
      };
    });
}
