/**
 * User-facing auth outcomes that must not reveal whether an email belongs to
 * a Lafiya account. Holding a Lafiya (health-card) account can itself disclose
 * a health status, so account existence is treated as sensitive (#527).
 *
 * These live outside the "use server" action files because those may only
 * export async functions.
 */

/**
 * Returned by sign-up for every well-formed request that is not rejected on
 * its own merits (invalid input, weak password): a new account, an existing
 * confirmed or unconfirmed account, and an email-send rate limit all get
 * exactly this.
 */
export const SIGN_UP_CHECK_EMAIL_MESSAGE =
  "Check your email for a link to confirm your account, then sign in. If you already have a Lafiya account, you can sign in instead.";

/** Returned by sign-in for every credential failure, known email or not. */
export const SIGN_IN_FAILED_MESSAGE = "Incorrect email or password.";

/**
 * Sign-in lockout. The limiter is keyed on (email, IP) and counts failures
 * the same way whether or not the account exists, so this message does not
 * reveal existence either.
 */
export function signInLockedOutMessage(secondsRemaining: number): string {
  return `Too many failed sign-in attempts. Please try again in ${secondsRemaining} seconds.`;
}
