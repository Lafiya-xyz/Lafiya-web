/**
 * Pure reference models of the Postgres limiter functions, used by
 * tests/integration/rate-limit-model.test.ts to model-check the real SQL
 * against the intended schedule (issue #783). Time is expressed in whole
 * seconds of elapsed virtual time so the models stay deterministic.
 */

export const LOCKOUT_THRESHOLD = 5;
export const BASE_LOCKOUT_SECONDS = 30;
export const MAX_LOCKOUT_SECONDS = 900;

/** Lockout length after the `attempts`-th consecutive failure, or null. */
export function lockoutSeconds(attempts: number): number | null {
  if (attempts < LOCKOUT_THRESHOLD) return null;
  return Math.min(
    MAX_LOCKOUT_SECONDS,
    BASE_LOCKOUT_SECONDS * 2 ** (attempts - LOCKOUT_THRESHOLD),
  );
}

export type RateLimitAction =
  | { kind: "failure" }
  | { kind: "success" }
  | { kind: "advance"; seconds: number };

export interface RateLimitModelState {
  /** null once recordSuccess has deleted the row. */
  attempts: number | null;
}

/**
 * Failures increment the counter; success deletes the row; elapsed time
 * never resets the counter (only a success does).
 */
export function stepRateLimit(
  state: RateLimitModelState,
  action: RateLimitAction,
): RateLimitModelState {
  switch (action.kind) {
    case "failure":
      return { attempts: (state.attempts ?? 0) + 1 };
    case "success":
      return { attempts: null };
    case "advance":
      return state;
  }
}

export type FrequencyAction =
  { kind: "hit" } | { kind: "advance"; seconds: number };

export interface FrequencyModelState {
  /** Seconds elapsed since the current window opened; null if no row. */
  elapsed: number | null;
  count: number;
}

export interface FrequencyHitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/** Fixed window opened by the first hit, reset once fully elapsed. */
export function stepFrequency(
  state: FrequencyModelState,
  action: FrequencyAction,
  maxCount: number,
  windowSeconds: number,
): { state: FrequencyModelState; result?: FrequencyHitResult } {
  if (action.kind === "advance") {
    return {
      state: {
        ...state,
        elapsed: state.elapsed === null ? null : state.elapsed + action.seconds,
      },
    };
  }
  const expired = state.elapsed === null || state.elapsed >= windowSeconds;
  const next = expired
    ? { elapsed: 0, count: 1 }
    : { elapsed: state.elapsed!, count: state.count + 1 };
  const allowed = next.count <= maxCount;
  return {
    state: next,
    result: {
      allowed,
      count: next.count,
      retryAfterSeconds: allowed
        ? 0
        : Math.max(0, Math.ceil(windowSeconds - next.elapsed)),
    },
  };
}
