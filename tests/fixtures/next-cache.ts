import { vi } from "vitest";

export const mockUnstableCache = vi.hoisted(() => {
  vi.mock("next/cache", () => ({
    // Models TTL/`revalidate` behavior, not just "cache forever keyed by
    // args" — a cache mock that never expires can't exercise expiry
    // behavior at all. Callers that don't pass `revalidate` keep the
    // original cache-forever semantics.
    unstable_cache: (
      fn: (...args: unknown[]) => unknown,
      _keyParts?: string[],
      options?: { revalidate?: number },
    ) => {
      const cacheStore = new Map<string, { value: unknown; cachedAt: number }>();
      const ttlMs = (options?.revalidate ?? Infinity) * 1000;
      return async (...args: unknown[]) => {
        const key = JSON.stringify(args);
        const entry = cacheStore.get(key);
        if (entry && Date.now() - entry.cachedAt < ttlMs) {
          return entry.value;
        }
        const result = await fn(...args);
        cacheStore.set(key, { value: result, cachedAt: Date.now() });
        return result;
      };
    },
  }));

  return true;
});
