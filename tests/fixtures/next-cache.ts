import { vi } from "vitest";

export const mockUnstableCache = vi.hoisted(() => {
  vi.mock("next/cache", () => ({
    unstable_cache: (fn: (...args: unknown[]) => unknown) => {
      const cacheStore = new Map<string, unknown>();
      return async (...args: unknown[]) => {
        const key = JSON.stringify(args);
        if (cacheStore.has(key)) {
          return cacheStore.get(key);
        }
        const result = await fn(...args);
        cacheStore.set(key, result);
        return result;
      };
    },
  }));

  return true;
});
