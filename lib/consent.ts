/**
 * Consent policy configuration.
 *
 * The single source of truth for the currently-active consent policy version.
 * Previously this was hard-coded inside `app/(auth)/signup/actions.ts`; it is
 * centralised here so the version lives in exactly one place and both signup
 * and the profile acknowledgement path stay in sync (see issue #146).
 */
export const CURRENT_POLICY_VERSION = "ndpa-2023-v1";

/** Human-readable label for the active policy, used in the UI. */
export const CURRENT_POLICY_LABEL = "NDPA (2023)";

/** Routes the active policy content is linked from. */
export const POLICY_ROUTES = {
  terms: "/terms",
  privacy: "/privacy",
} as const;
