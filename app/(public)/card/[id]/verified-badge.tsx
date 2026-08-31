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

export function VerifiedBadge({ status }: { status: VerificationStatus }) {
  if (status === "verified") {
    return (
      <span 
        className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-sm font-medium text-white dark:bg-emerald-600 dark:text-white"
        aria-label="Verified: Health-worker attestation finalized"
      >
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
        Health-worker attestation finalized
      </span>
    );
  }

  if (status === "unavailable") {
    return (
      <span 
        className="inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1 text-sm font-medium text-white dark:bg-amber-600 dark:text-white"
        aria-label="Verification status unavailable"
      >
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
      <span 
        className="inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1 text-sm font-medium text-white dark:bg-amber-600 dark:text-white"
        aria-label={label}
      >
        {label}
      </span>
    );
  }

  return (
    <span 
      className="inline-flex w-fit items-center gap-1.5 rounded-full bg-zinc-500 px-3 py-1 text-sm font-medium text-white dark:bg-zinc-600 dark:text-white"
      aria-label="Not yet verified"
    >
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
      Not yet verified
    </span>
  );
}
