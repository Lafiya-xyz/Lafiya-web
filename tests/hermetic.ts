/**
 * Hermetic unit-test guards (Issue #956).
 *
 * Unit tests must not depend on the outside world: no real network, no wall
 * clock, no unseeded randomness. This module installs those guards and is
 * wired in from `tests/setup.ts`, so every unit test file gets them.
 *
 * Opting out (per file, at the top of the file):
 *   // @hermetic-network off   -> allow real fetch/http(s)/dns
 *   // @hermetic-time off      -> keep the real clock (no fake timers)
 *   // @hermetic-random off    -> keep the real Math.random
 *
 * A test that needs the real clock for a moment can also call
 * `vi.useRealTimers()` itself; the guard only sets the default.
 */
import { afterEach, beforeEach, vi } from "vitest";

/** Fixed instant used when time is frozen. */
export const FROZEN_NOW = new Date("2026-01-01T00:00:00.000Z");

/** Seed used for the deterministic `Math.random` replacement. */
export const RANDOM_SEED = 0x5eed;

const NETWORK_MODULES = ["node:http", "node:https", "node:dns", "undici"];

function networkError(what: string): Error {
  return new Error(
    `[hermetic] Unmocked network call blocked: ${what}.\n` +
      "Unit tests must not touch the network. Mock the module that performs " +
      "the request (e.g. `vi.mock(\"@/lib/...\")`) or stub `fetch` with " +
      "`vi.stubGlobal(\"fetch\", vi.fn())`. If this file genuinely needs the " +
      "network, add `// @hermetic-network off` at the top of the file.",
  );
}

/** Deterministic PRNG (mulberry32) so `Math.random` is reproducible. */
export function seededRandom(seed: number = RANDOM_SEED): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blockNetwork(): void {
  const blockedFetch = (input: unknown) => {
    const target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string } | undefined)?.url ?? "<request>");
    return Promise.reject(networkError(`fetch(${target})`));
  };
  vi.stubGlobal("fetch", blockedFetch);

  // `vi.mock` is hoisted, so it must be called at module scope (below) rather
  // than from inside this hook; the mocks themselves are inert until a test
  // file imports the module, which is exactly the behaviour we want.
}

// Hoisted by Vitest: any test file that imports node:http(s)/dns/undici gets
// a module whose every export throws the hermetic error instead of dialling
// out. Files that mock these modules themselves keep their own mock.
for (const id of NETWORK_MODULES) {
  vi.mock(id, () => {
    const fail = (name: string) => () => {
      throw networkError(`${id} ${name}()`);
    };
    return new Proxy(
      {},
      {
        get: (_target, prop) =>
          typeof prop === "string" ? fail(prop) : undefined,
      },
    );
  });
}

function seedRandom(): void {
  vi.spyOn(Math, "random").mockImplementation(seededRandom());
}

function freezeTime(): void {
  vi.useFakeTimers({ now: FROZEN_NOW, shouldAdvanceTime: false });
}

beforeEach(() => {
  freezeTime();
  seedRandom();
  blockNetwork();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("node:http");
  vi.doUnmock("node:https");
  vi.doUnmock("node:dns");
  vi.doUnmock("undici");
});
