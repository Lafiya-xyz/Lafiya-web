/**
 * Branded bigint `Stroops` type for USDC amounts (#894).
 *
 * USDC on Stellar has 7 decimal places, so one USDC is 10_000_000 stroops.
 * Every payout amount is carried as an integer number of stroops so that
 * summation, splitting and formatting are exact and cannot drift the way
 * IEEE-754 doubles do. The brand makes a plain `number` or `bigint`
 * structurally incompatible with `Stroops`, so mixing them is a type error.
 *
 * No floating point is used anywhere in this module: parsing and formatting
 * are pure string/integer operations.
 */

export const STROOPS_DECIMALS = 7;
export const STROOPS_PER_UNIT = 10n ** BigInt(STROOPS_DECIMALS);

declare const STROOPS_BRAND: unique symbol;

/** An exact USDC amount, in stroops (1 USDC = 10_000_000 stroops). */
export type Stroops = bigint & { readonly [STROOPS_BRAND]: "Stroops" };

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/** Wraps a raw bigint as `Stroops`. Throws on negative or non-integer input. */
export function stroops(value: bigint): Stroops {
  if (typeof value !== "bigint") {
    throw new TypeError("stroops() requires a bigint; use parseStroops() for decimal strings");
  }
  if (value < 0n) throw new RangeError(`stroops amount must be non-negative, got ${value}`);
  return value as Stroops;
}

export const ZERO_STROOPS: Stroops = stroops(0n);

/**
 * Parses a non-negative decimal string (e.g. "12.5000000") into exact
 * stroops. Rejects signs, exponents, empty strings and more than 7 decimal
 * places rather than silently rounding.
 */
export function parseStroops(value: string): Stroops {
  if (typeof value !== "string") {
    throw new TypeError("parseStroops() requires a decimal string");
  }
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) throw new Error(`invalid USDC amount: ${JSON.stringify(value)}`);
  const [, whole, frac = ""] = match;
  if (frac.length > STROOPS_DECIMALS) {
    throw new Error(
      `USDC amount has more than ${STROOPS_DECIMALS} decimal places: ${JSON.stringify(value)}`,
    );
  }
  const scaled = BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac.padEnd(STROOPS_DECIMALS, "0") || "0");
  return stroops(scaled);
}

/** Formats stroops as a fixed 7-decimal USDC string (the on-chain wire form). */
export function formatStroops(amount: Stroops): string {
  const whole = amount / STROOPS_PER_UNIT;
  const frac = (amount % STROOPS_PER_UNIT).toString().padStart(STROOPS_DECIMALS, "0");
  return `${whole}.${frac}`;
}

/** Exact sum; order-independent because bigint addition is associative. */
export function sumStroops(amounts: readonly Stroops[]): Stroops {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return stroops(total);
}

/**
 * Splits `total` into `parts` shares that sum back to `total` exactly.
 * The remainder (total % parts) is distributed one stroop at a time to the
 * first shares, so no stroop is created or lost.
 */
export function splitStroops(total: Stroops, parts: number): Stroops[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`parts must be a positive integer, got ${parts}`);
  }
  const divisor = BigInt(parts);
  const base = total / divisor;
  const remainder = total % divisor;
  return Array.from({ length: parts }, (_, i) =>
    stroops(base + (BigInt(i) < remainder ? 1n : 0n)),
  );
}

/** Adds two amounts exactly. */
export function addStroops(a: Stroops, b: Stroops): Stroops {
  return stroops(a + b);
}

/** Subtracts `b` from `a`; throws if the result would be negative. */
export function subtractStroops(a: Stroops, b: Stroops): Stroops {
  return stroops(a - b);
}
