# Type-level tests

Type tests pin the _shape_ of types whose regressions compile fine but break
callers at runtime or leak fields. They live in `tests/types/*.typetest.ts`,
cost nothing at runtime, and run as part of `npm run typecheck` (vitest only
picks up `*.test.ts`, so they are never executed).

## How they work

`tests/types/assert.ts` provides two helpers:

- `Equal<A, B>` — `true` only if `A` and `B` are mutually identical (not just
  assignable), so adding, removing or loosening a field is caught.
- `Expect<T extends true>` — fails typecheck when given `false`.

```ts
export type _CardArgs = Expect<Equal<CardRpc["Args"], { p_card_id: string }>>;
```

Negative tests use `// @ts-expect-error` on an assignment that must be
rejected. If the assignment ever starts compiling, the unused directive is
itself an error:

```ts
// @ts-expect-error raw number is not a UsdcAmount
export const rawNumber: UsdcAmount = 412.5;
```

## What deserves a type test

Add one when a type is a **contract** and a silent change would be harmful:

- **Public RPC return shapes** (e.g. `get_emergency_card`) — pin the exact key
  set so a new column can't reach the unauthenticated card unnoticed.
- **Sensitive table rows** (e.g. `profile_secrets`) — pin row shape and assert
  sensitive keys are _absent_ from public types.
- **Branded / nominal types** (e.g. `UsdcAmount` in `lib/types/brand.ts`) —
  add `@ts-expect-error` cases proving raw primitives are rejected.
- **Domain unions that drive exhaustive switches** (e.g. `TrustState`) — pin
  the members so additions force a review of every `switch`.

Don't add type tests for internal helpers, inferred component props, or types
already covered by runtime tests — they add churn without catching anything.

When a contract changes intentionally, update the type test in the same PR as
the migration and `lib/supabase/types.ts` (see `npm run types:verify`).
