/**
 * VERIFICATION STATUS FLOW
 *
 * The VerifiedBadge component displays verification status derived from the
 * emergency card's `trust_state` field, which is populated by `lib/stellar/attestation.ts`
 * via the `getAttestation()` and `validateAttestation()` functions. The data flow is:
 *
 * 1. card-content.tsx receives the card from the server
 * 2. card-content.tsx maps card.trust_state to a VerificationStatus (enum below)
 * 3. card-content.tsx passes the status to VerifiedBadge
 * 4. VerifiedBadge renders the appropriate visual badge for that status
 *
 * DATA ORIGIN:
 * The verification status originates from lib/stellar/attestation.ts:
 * - getAttestation(recordHash): Fetches the on-chain attestation via Soroban RPC
 * - validateAttestation(recordHash): Checks if an attestation is present, not expired,
 *   and not revoked (returns boolean)
 * - The attestation contract is deployed on Stellar Soroban and indexed by recordHash
 *   (see lib/attestation/recordHash.ts for hash computation)
 * - Results are cached for ATTESTATION_CACHE_TTL_SECONDS (default 120s) to reduce RPC load
 *
 * POSSIBLE STATES AND THEIR MEANING:
 *
 * 1. "verified" (green check badge)
 *    - Health-worker attestation is finalized on-chain
 *    - The attestation exists, is not revoked, and not expired
 *    - Responder should trust this record as verified by a health professional
 *    - Rendered in emerald/green (high confidence)
 *
 * 2. "not_verified" (question mark badge, gray)
 *    - No finalized attestation exists for this record hash
 *    - The record may be recent, the health worker hasn't verified it yet, or
 *      verification was intentionally not sought
 *    - Responder should treat this as unverified but the data may still be accurate
 *    - Rendered in zinc/gray (neutral, not negative)
 *
 * 3. "submitted" (amber/yellow badge)
 *    - Health-worker verification has been submitted but not yet finalized on-chain
 *    - The attestation exists but is pending on-chain confirmation
 *    - Transient state; should resolve to "verified" or fail within minutes
 *    - Rendered in amber (informational, in-progress)
 *
 * 4. "confirming" (amber/yellow badge)
 *    - Verification attestation is awaiting Stellar ledger finality
 *    - The health-worker signature is present but consensus is not yet reached
 *    - Similar to "submitted"; watch for this to move to verified or fail
 *    - Rendered in amber (informational, in-progress)
 *
 * 5. "expired" (amber/yellow badge)
 *    - The attestation evidence has expired (TTL passed)
 *    - The health-worker verification was valid at one point but is no longer current
 *    - Responder should consider the record stale; patient should seek new verification
 *    - Rendered in amber (caution/informational)
 *
 * 6. "revoked" (amber/yellow badge)
 *    - The health-worker explicitly revoked their attestation
 *    - The health-worker no longer stands behind this record
 *    - Responder should not rely on this record without re-verification
 *    - Rendered in amber (caution)
 *
 * 7. "superseded" (amber/yellow badge)
 *    - The attestation applies to an older record version
 *    - The patient has updated their emergency information since verification
 *    - The verification is still valid but applies to outdated data
 *    - Rendered in amber (informational; record was updated post-verification)
 *
 * 8. "conflicted" (amber/yellow badge)
 *    - Multiple attestations exist for this record with conflicting signatures
 *    - Requires manual reconciliation by the health-worker or system admin
 *    - Responder should not rely on a conflicted record
 *    - Rendered in amber (caution; conflict detected)
 *
 * 9. "unavailable" (amber/yellow badge)
 *    - Attestation verification status could not be determined
 *    - Possible causes: RPC timeout, network error, circuit breaker open, or
 *      ATTESTATION_CONTRACT_ID not configured (local dev falls back to mock)
 *    - The emergency data is still displayed; verification lookup failed, not the data itself
 *    - Rendered in amber (informational; service degraded but card still readable)
 *
 * RENDERING LOGIC:
 * - "verified": Green check badge with finalized message
 * - "not_verified": Gray question mark badge with "Not yet verified"
 * - All others: Amber badge with status-specific label (from pendingLabels map)
 * - Unknown or fallback: Gray question mark badge
 *
 * FORCED-COLORS / WINDOWS HIGH CONTRAST:
 * The badge previously relied on background colour alone to convey status, which
 * disappears under `forced-colors: active`. Each state now carries a distinct
 * icon (check, question mark, clock, warning) plus a visible border so the
 * status stays distinguishable when the OS overrides colours. The QR code is
 * handled separately and keeps `forced-color-adjust: none` so it still decodes.
 *
 * IMPLEMENTATION NOTE:
 * The badge is purely presentational. It does NOT fetch attestation data itself;
 * all verification is pre-computed on the server and passed via card.trust_state.
 * This ensures the badge renders instantly and consistently, with no client-side
 * RPC calls or race conditions.
 */

export type VerificationStatus =
  | "verified"
  | "not_verified"
  | "submitted"
  | "confirming"
  | "expired"
  | "revoked"
  | "superseded"
  | "conflicted"
  | "unavailable";

function CheckIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 fill-current"
      viewBox="0 0 20 20"
      aria-hidden="true"
      data-testid="verified-icon"
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function QuestionIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 stroke-current"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="unverified-icon"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 stroke-current"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="pending-icon"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0 stroke-current"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="warning-icon"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

const badgeBase =
  "inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium";

// In forced-colors mode the OS replaces our colours, so we lean on system colour
// keywords and a visible border to keep each state distinguishable.
const verifiedClasses = `${badgeBase} border-emerald-700 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-600 dark:text-white forced-colors:border-[CanvasText] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]`;
const pendingClasses = `${badgeBase} border-amber-700 bg-amber-600 text-white dark:border-amber-500 dark:bg-amber-600 dark:text-white forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]`;
const neutralClasses = `${badgeBase} border-zinc-600 bg-zinc-500 text-white dark:border-zinc-400 dark:bg-zinc-600 dark:text-white forced-colors:border-[CanvasText] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]`;

export function VerifiedBadge({ status }: { status: VerificationStatus }) {
  if (status === "verified") {
    return (
      <span
        className={verifiedClasses}
        aria-label="Verified: Health-worker attestation finalized"
      >
        <CheckIcon />
        Health-worker attestation finalized
      </span>
    );
  }

  if (status === "unavailable") {
    return (
      <span
        className={pendingClasses}
        aria-label="Verification status unavailable"
      >
        <WarningIcon />
        Verification status unavailable
      </span>
    );
  }

  const pendingLabels: Partial<Record<VerificationStatus, string>> = {
    submitted: "Health-worker verification submitted",
    confirming: "Verification awaiting ledger finality",
    expired: "Verification evidence expired",
    revoked: "Verification evidence revoked",
    superseded: "Verification applies to an older record version",
    conflicted: "Verification evidence needs reconciliation",
  };
  const label = pendingLabels[status];
  if (label) {
    return (
      <span className={pendingClasses} aria-label={label}>
        <ClockIcon />
        {label}
      </span>
    );
  }

  return (
    <span className={neutralClasses} aria-label="Not yet verified">
      <QuestionIcon />
      Not yet verified
    </span>
  );
}
