/**
 * Nominal ("branded") types. A raw primitive cannot be assigned to a branded
 * type without going through its constructor, so money and identifiers can't
 * be mixed up by accident. Pinned by tests/types/core-types.typetest.ts.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** USDC amount as a 7-decimal string, e.g. "412.5000000". */
export type UsdcAmount = Brand<string, "UsdcAmount">;

const USDC_AMOUNT_PATTERN = /^\d+\.\d{7}$/;

export function toUsdcAmount(value: string): UsdcAmount {
  if (!USDC_AMOUNT_PATTERN.test(value)) {
    throw new TypeError(`Invalid USDC amount: ${value}`);
  }
  return value as UsdcAmount;
}
