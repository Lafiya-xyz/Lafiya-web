// vitest-axe@0.1.0 augments Vitest's old `Vi` global namespace, which no
// longer exists in vitest@4's type system (custom matchers are now declared
// via `Matchers<T>` from `@vitest/expect`, re-exported by `vitest`). This
// restores the `toHaveNoViolations` matcher's type for the actual interface
// vitest 4 uses, so `expect.extend(matchers)` (wired up in tests/setup.ts)
// type-checks correctly.
export {};

declare module "@vitest/expect" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match Matchers<T>'s arity to merge
  interface Matchers<T = unknown> {
    toHaveNoViolations(): void;
  }
}
