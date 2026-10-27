/**
 * FX rate snapshots with provenance for fiat-equivalent reporting (#806).
 *
 * Reports never convert at render time: they reference an immutable
 * snapshot (source, pair, rate, observedAt) by ID, so re-running a
 * historical report reproduces identical fiat figures. When the rate
 * source is unavailable, the latest stored snapshot is reused but flagged
 * `indicative` instead of silently passing stale data off as current.
 *
 * Rounding (see docs/funder-report-schema.md): rates are stored at 7 dp;
 * fiat = usdc × rate computed in scaled integers and rounded half-up to
 * 2 dp (kobo). No floating point anywhere.
 */

export const RATE_DECIMALS = 7;
export const FIAT_DECIMALS = 2;
/** A snapshot older than this, relative to the report period end, is indicative. */
export const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

export interface FxRateSnapshot {
  snapshotId: string;
  source: string;
  pair: string;
  /** Decimal string, 7 dp. */
  rate: string;
  observedAt: string;
  indicative: boolean;
}

export interface FiatEquivalent {
  amountFiat: string;
  snapshotId: string;
  rateSource: string;
  rateObservedAt: string;
  indicative: boolean;
}

export interface FxRateSource {
  name: string;
  fetchRate(pair: string): Promise<{ rate: string; observedAt: Date }>;
}

export interface FxSnapshotStore {
  insert(snapshot: Omit<FxRateSnapshot, "snapshotId"> & { period: string | null }): Promise<FxRateSnapshot>;
  latest(pair: string): Promise<FxRateSnapshot | null>;
  byId(snapshotId: string): Promise<FxRateSnapshot | null>;
}

function toScaled(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`invalid decimal: ${value}`);
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function fromScaled(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}

/** Normalizes a source-provided rate to the stored 7 dp form (half-up). */
export function normalizeRate(rate: string): string {
  const [whole, frac = ""] = rate.split(".");
  const scaled = toScaled(`${whole}.${frac.slice(0, RATE_DECIMALS)}`, RATE_DECIMALS);
  const roundUp = (frac[RATE_DECIMALS] ?? "0") >= "5" ? 1n : 0n;
  return fromScaled(scaled + roundUp, RATE_DECIMALS);
}

/** usdc (7 dp) × rate (7 dp) → fiat rounded half-up to 2 dp. */
export function convertUsdcToFiat(amountUsdc: string, rate: string): string {
  const product = toScaled(amountUsdc, 7) * toScaled(rate, RATE_DECIMALS); // 14 dp
  const divisor = 10n ** BigInt(7 + RATE_DECIMALS - FIAT_DECIMALS);
  return fromScaled((product + divisor / 2n) / divisor, FIAT_DECIMALS);
}

/**
 * Captures a snapshot for `pair` (scheduled, or per payout period). On a
 * source outage, returns the latest stored snapshot re-flagged indicative;
 * throws only if there is no prior snapshot at all.
 */
export async function captureSnapshot(
  source: FxRateSource,
  store: FxSnapshotStore,
  pair: string,
  period: string | null = null,
): Promise<FxRateSnapshot> {
  try {
    const { rate, observedAt } = await source.fetchRate(pair);
    return await store.insert({
      source: source.name,
      pair,
      rate: normalizeRate(rate),
      observedAt: observedAt.toISOString(),
      indicative: false,
      period,
    });
  } catch (error) {
    const fallback = await store.latest(pair);
    if (!fallback) throw error;
    return { ...fallback, indicative: true };
  }
}

/** Pure conversion against a stored snapshot; identical inputs → identical output. */
export function fiatEquivalent(
  amountUsdc: string,
  snapshot: FxRateSnapshot,
  asOf?: Date,
): FiatEquivalent {
  const stale =
    asOf !== undefined && asOf.getTime() - new Date(snapshot.observedAt).getTime() > MAX_SNAPSHOT_AGE_MS;
  return {
    amountFiat: convertUsdcToFiat(amountUsdc, snapshot.rate),
    snapshotId: snapshot.snapshotId,
    rateSource: snapshot.source,
    rateObservedAt: snapshot.observedAt,
    indicative: snapshot.indicative || stale,
  };
}
