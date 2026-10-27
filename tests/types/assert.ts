/**
 * Zero-runtime type assertions (expect-type/tsd style). Files named
 * *.typetest.ts are checked by `npm run typecheck`; vitest never runs them.
 */
export type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

export type Expect<T extends true> = T;
