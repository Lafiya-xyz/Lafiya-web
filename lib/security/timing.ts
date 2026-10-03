// Kept free of path aliases and runtime-only TypeScript syntax so the
// benchmark harness (bench/auth-enumeration/harness.mjs) can import this exact
// file under Node's built-in type stripping.

/**
 * Minimum wall-clock duration of a sign-in attempt. Supabase only runs the
 * bcrypt comparison when the email belongs to an account, so an unpadded
 * "wrong password" is measurably slower than "no such account". The floor is
 * set above the observed p99 of a local signInWithPassword round trip plus
 * the rate-limit bookkeeping. Measure with
 * `node bench/auth-enumeration/harness.mjs`.
 */
export const SIGN_IN_TIMING_FLOOR_MS = 1000;

/**
 * Minimum wall-clock duration of a sign-up attempt. Creating an account
 * inserts rows and (with confirmations on) sends an email, while an existing
 * email returns early, so this floor sits above the p99 of the slow path.
 */
export const SIGN_UP_TIMING_FLOOR_MS = 2000;

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

const defaultClock: Clock = () => performance.now();
const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation` and does not settle until at least `floorMs` has passed
 * since it started, whether it resolves or throws. Throwing matters because
 * Next's `redirect()` throws: a successful sign-in must be padded exactly
 * like a failed one.
 *
 * If the operation overruns the floor, nothing is added. Keep each floor
 * above the operation's p99 so overruns are rare.
 */
export async function withTimingFloor<T>(
  floorMs: number,
  operation: () => Promise<T>,
  clock: Clock = defaultClock,
  sleep: Sleep = defaultSleep,
): Promise<T> {
  const startedAt = clock();
  const pad = async () => {
    const remaining = floorMs - (clock() - startedAt);
    if (remaining > 0) await sleep(remaining);
  };

  let result: T;
  try {
    result = await operation();
  } catch (error) {
    await pad();
    throw error;
  }
  await pad();
  return result;
}
