/**
 * Strict-receive path payments for CHW payouts (issue #899).
 *
 * A CHW can express a payout asset preference (e.g. a local stablecoin or
 * anchor-issued asset). We still owe them a fixed USDC-equivalent amount, so
 * the payment is submitted as `pathPaymentStrictReceive`: the destination
 * receives exactly `destAmount` of the preferred asset, and the source spends
 * at most `sendMax` USDC. `sendMax` is derived from the best path found by
 * Horizon's strict-receive path finder plus a configurable slippage bound.
 *
 * If no path fits inside the cap (or no path exists at all), the payout falls
 * back to a plain USDC payment -- the CHW is never underpaid and the sponsor
 * pool never overpays beyond the cap.
 *
 * Every decision records the path, the effective rate and the realised
 * slippage so funder reports can state the exact USDC-equivalent cost.
 */

import { Asset, Operation, type Horizon } from "@stellar/stellar-sdk";

/** Default slippage bound applied to the best quoted path (0.5%). */
export const DEFAULT_MAX_SLIPPAGE_BPS = 50;
export const MAX_ALLOWED_SLIPPAGE_BPS = 1_000;

const STROOPS_PER_UNIT = 10_000_000n;

export interface PayoutAssetPreference {
  /** Asset the CHW wants to receive, e.g. `{ code: "NGNC", issuer: "G..." }`. */
  asset: Asset;
  /** Slippage bound in basis points (1 bps = 0.01%). Clamped to [0, 1000]. */
  maxSlippageBps?: number;
}

export interface PathQuote {
  /** Assets the payment hops through between source and destination asset. */
  path: Asset[];
  /** Destination amount, in units of the destination asset (7 dp string). */
  destinationAmount: string;
  /** USDC the source would spend for this quote (7 dp string). */
  sourceAmount: string;
}

export interface PathPaymentPlan {
  mode: "path_payment" | "usdc_fallback";
  /** Asset actually delivered to the CHW. */
  destinationAsset: Asset;
  /** Exact amount delivered, 7 dp string. */
  destinationAmount: string;
  /** Upper bound on USDC spent, 7 dp string. */
  sendMax: string;
  /** Intermediate assets; empty for a direct hop or the USDC fallback. */
  path: Asset[];
  /** USDC per destination-asset unit implied by the quote, 7 dp string. */
  rate: string;
  /** Slippage bound that was applied, in basis points. */
  maxSlippageBps: number;
  /** Why the fallback was taken; null for a path payment. */
  fallbackReason: "no_path" | "slippage_cap_exceeded" | null;
}

export interface PathPaymentPlanInput {
  /** USDC amount owed to the CHW (7 dp string). */
  amountUsdc: string;
  usdcAsset: Asset;
  preference: PayoutAssetPreference | null | undefined;
  /** Quotes from Horizon's strict-receive path finder, best first. */
  quotes: PathQuote[];
}

/** Clamps a requested slippage bound into the accepted range. */
export function clampSlippageBps(requested: number | undefined): number {
  const bps = requested ?? DEFAULT_MAX_SLIPPAGE_BPS;
  if (!Number.isFinite(bps) || bps < 0) return 0;
  return Math.min(Math.floor(bps), MAX_ALLOWED_SLIPPAGE_BPS);
}

/**
 * Chooses between a slippage-bounded path payment and the plain USDC
 * fallback. Pure: all Horizon I/O happens in the caller.
 */
export function planPathPayment(input: PathPaymentPlanInput): PathPaymentPlan {
  const amountUsdc = normalizeAmount(input.amountUsdc);
  const maxSlippageBps = clampSlippageBps(input.preference?.maxSlippageBps);

  const fallback = (reason: PathPaymentPlan["fallbackReason"]): PathPaymentPlan => ({
    mode: "usdc_fallback",
    destinationAsset: input.usdcAsset,
    destinationAmount: amountUsdc,
    sendMax: amountUsdc,
    path: [],
    rate: "1.0000000",
    maxSlippageBps,
    fallbackReason: reason,
  });

  if (!input.preference) return fallback("no_path");

  const best = input.quotes[0];
  if (!best) return fallback("no_path");

  const sendMax = applySlippage(best.sourceAmount, maxSlippageBps);
  // The cap is the USDC we are willing to spend: the quoted cost plus the
  // slippage bound, never more than the amount owed to the CHW.
  if (compareAmounts(sendMax, amountUsdc) > 0) {
    return fallback("slippage_cap_exceeded");
  }

  return {
    mode: "path_payment",
    destinationAsset: input.preference.asset,
    destinationAmount: normalizeAmount(best.destinationAmount),
    sendMax,
    path: best.path,
    rate: divideAmounts(sendMax, best.destinationAmount),
    maxSlippageBps,
    fallbackReason: null,
  };
}

/** Builds the Stellar operation for a plan (strict-receive or plain payment). */
export function buildPayoutOperation(
  plan: PathPaymentPlan,
  recipientAddress: string,
  usdcAsset: Asset,
): ReturnType<typeof Operation.payment> {
  if (plan.mode === "usdc_fallback") {
    return Operation.payment({
      destination: recipientAddress,
      asset: usdcAsset,
      amount: plan.destinationAmount,
    });
  }
  return Operation.pathPaymentStrictReceive({
    sendAsset: usdcAsset,
    sendMax: plan.sendMax,
    destination: recipientAddress,
    destAsset: plan.destinationAsset,
    destAmount: plan.destinationAmount,
    path: plan.path,
  });
}

/**
 * Queries Horizon for strict-receive paths and returns them best-first.
 * Returns an empty list on any Horizon error so callers fall back to USDC
 * rather than failing the payout.
 */
export async function fetchPathQuotes(
  server: Horizon.Server,
  params: {
    sourceAsset: Asset;
    destinationAsset: Asset;
    destinationAmount: string;
  },
): Promise<PathQuote[]> {
  try {
    const response = await server
      .strictReceivePaths(
        params.sourceAsset,
        params.destinationAsset,
        params.destinationAmount,
      )
      .call();
    const records = (response as { records?: unknown[] }).records ?? [];
    return records
      .map((record) => {
        const r = record as {
          source_amount?: string;
          destination_amount?: string;
          path?: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string }>;
        };
        if (!r.source_amount || !r.destination_amount) return null;
        return {
          path: (r.path ?? []).map((hop) =>
            hop.asset_type === "native"
              ? Asset.native()
              : new Asset(hop.asset_code as string, hop.asset_issuer as string),
          ),
          sourceAmount: r.source_amount,
          destinationAmount: r.destination_amount,
        } satisfies PathQuote;
      })
      .filter((quote): quote is PathQuote => quote !== null)
      .sort((a, b) => compareAmounts(a.sourceAmount, b.sourceAmount));
  } catch {
    return [];
  }
}

/** Adds `bps` basis points of headroom to a 7 dp amount string. */
export function applySlippage(amount: string, bps: number): string {
  const scaled = toStroops(amount);
  const bumped = (scaled * BigInt(10_000 + bps) + 9_999n) / 10_000n;
  return fromStroops(bumped);
}

/** Compares two 7 dp amount strings: -1, 0 or 1. */
export function compareAmounts(a: string, b: string): number {
  const left = toStroops(a);
  const right = toStroops(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function divideAmounts(numerator: string, denominator: string): string {
  const den = toStroops(denominator);
  if (den === 0n) return "0.0000000";
  return fromStroops((toStroops(numerator) * STROOPS_PER_UNIT) / den);
}

function normalizeAmount(amount: string): string {
  return fromStroops(toStroops(amount));
}

function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid amount: ${amount}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(7)).slice(0, 7);
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fracPadded || "0");
}

function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}
