/**
 * Issue #885: conservative Speculation Rules for the authenticated app.
 *
 * Only same-origin, read-only profile routes are eligible. Card routes
 * (/card/*, /card/c/*) are bearer capabilities whose views are audited and
 * view-counted, and every mutation route (server actions, /api/*, /r/*,
 * /scan, /signout, /profile/export, /profile/merge, /profile/verify-step-up,
 * /profile/consent)
 * must never be speculated. The exclusion list is applied *after* the
 * inclusion list so a future inclusion pattern can never widen the blast
 * radius by accident.
 */
export const SPECULATION_RULES_ID = "lafiya-profile-speculation";

/** Read-only, non-audited authenticated pages that are safe to prerender. */
export const SPECULATED_PATHS = ["/profile", "/profile/security"] as const;

/**
 * `href_matches` patterns for the inclusion list. `/profile` matches the
 * profile page itself; `/profile/security` matches the security center.
 */
const SPECULATED_HREF_MATCHES = SPECULATED_PATHS.join("|");

/** Never speculate these, even if an inclusion pattern would match. */
export const EXCLUDED_PATH_PREFIXES = [
  "/card",
  "/api",
  "/r",
  "/scan",
  "/signin",
  "/signup",
  "/signout",
  "/profile/export",
  "/profile/merge",
  "/profile/verify-step-up",
  "/profile/consent",
] as const;

export type SpeculationRules = {
  prerender: Array<{
    where: {
      and: [
        { href_matches: string },
        { not: { href_matches: string } },
      ];
    };
    eagerness: "conservative" | "moderate";
  }>;
};

export function buildSpeculationRules(): SpeculationRules {
  return {
    prerender: [
      {
        where: {
          and: [
            { href_matches: SPECULATED_HREF_MATCHES },
            {
              not: {
                href_matches: EXCLUDED_PATH_PREFIXES.map(
                  (prefix) => `${prefix}/*`,
                ).join("|"),
              },
            },
          ],
        },
        eagerness: "conservative",
      },
    ],
  };
}

/** True when a pathname must never be prefetched/prerendered. */
export function isSpeculationExcluded(pathname: string): boolean {
  return EXCLUDED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Browsers send `Sec-Purpose: prefetch` (and `Sec-Purpose: prefetch;prerender`
 * for prerender) on speculative requests. Server code that writes audit rows
 * must skip them so a prefetch never produces a false access event.
 */
export function isSpeculativeRequest(headers: Headers): boolean {
  const purpose = headers.get("sec-purpose") ?? headers.get("purpose") ?? "";
  return /(^|;|\s)(prefetch|prerender)(;|\s|$)/i.test(purpose);
}
