import { Horizon } from '@stellar/stellar-sdk';
import { createClient } from '@/lib/supabase/server';

/**
 * Aggregation helpers for the public funding-transparency page (#568).
 *
 * All figures are aggregates only. Small counts are suppressed to prevent
 * re-identification of individual verifications. No PHI is read or returned.
 */

/** Minimum number of verifications a region must have to be reported. */
export const SUPPRESSION_THRESHOLD = 10;

/** Revalidate the transparency page every 10 minutes (within the 5-15m budget). */
export const TRANSPARENCY_REVALIDATE_SECONDS = 600;

export interface RegionAggregate {
  region: string;
  verifiedCards: number;
  disbursed: number;
}

export interface FundingTransparency {
  poolBalance: number;
  totalDisbursed: number;
  verifiedCardsFunded: number;
  costPerVerifiedCard: number | null;
  regions: RegionAggregate[];
  suppressedRegions: number;
  asOfLedger: number;
  asOf: string;
}

interface PayoutRow {
  region: string | null;
  amount: number | string | null;
  verified_cards: number | string | null;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Aggregate raw payout rows into per-region totals, suppressing regions whose
 * verification count falls below the suppression threshold.
 */
export function aggregateRegions(rows: PayoutRow[]): {
  regions: RegionAggregate[];
  suppressedRegions: number;
} {
  const byRegion = new Map<string, RegionAggregate>();

  for (const row of rows) {
    const region = row.region?.trim() || 'Unspecified';
    const current = byRegion.get(region) ?? {
      region,
      verifiedCards: 0,
      disbursed: 0,
    };
    current.verifiedCards += toNumber(row.verified_cards);
    current.disbursed += toNumber(row.amount);
    byRegion.set(region, current);
  }

  const regions: RegionAggregate[] = [];
  let suppressedRegions = 0;

  for (const aggregate of byRegion.values()) {
    if (aggregate.verifiedCards < SUPPRESSION_THRESHOLD) {
      suppressedRegions += 1;
      continue;
    }
    regions.push(aggregate);
  }

  regions.sort((a, b) => b.disbursed - a.disbursed);
  return { regions, suppressedRegions };
}

/**
 * Fetch the live incentive pool balance from Horizon. Returns 0 when the
 * account is not configured or Horizon is unreachable so the page still renders.
 */
export async function fetchPoolBalance(): Promise<number> {
  const accountId = process.env.STELLAR_POOL_ACCOUNT;
  if (!accountId) return 0;

  try {
    const server = new Horizon.Server(
      process.env.STELLAR_HORIZON_URL ?? 'https://horizon.stellar.org',
    );
    const account = await server.loadAccount(accountId);
    const native = account.balances.find((b) => b.asset_type === 'native');
    return native ? toNumber(native.balance) : 0;
  } catch {
    return 0;
  }
}

/**
 * Build the full transparency payload from the payout tables and Horizon.
 * Aggregates only; no PHI is selected or returned.
 */
export async function getFundingTransparency(): Promise<FundingTransparency> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('payouts')
    .select('region, amount, verified_cards');

  if (error) throw error;

  const rows = (data ?? []) as PayoutRow[];
  const { regions, suppressedRegions } = aggregateRegions(rows);

  const totalDisbursed = rows.reduce((sum, row) => sum + toNumber(row.amount), 0);
  const verifiedCardsFunded = rows.reduce(
    (sum, row) => sum + toNumber(row.verified_cards),
    0,
  );
  const poolBalance = await fetchPoolBalance();

  return {
    poolBalance,
    totalDisbursed,
    verifiedCardsFunded,
    costPerVerifiedCard:
      verifiedCardsFunded > 0 ? totalDisbursed / verifiedCardsFunded : null,
    regions,
    suppressedRegions,
    asOfLedger: 0,
    asOf: new Date().toISOString(),
  };
}
