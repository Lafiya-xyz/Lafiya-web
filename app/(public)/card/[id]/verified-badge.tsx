export type VerificationStatus =
  | "unverified"
  | "submitted"
  | "confirming"
  | "verified"
  | "expired"
  | "revoked"
  | "superseded"
  | "conflicted"
  | "unavailable";

export function VerifiedBadge({ status }: { status: VerificationStatus }) {
  if (status === "verified") {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
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
        Verified by a health worker
      </span>
    );
  }

  if (["submitted", "confirming"].includes(status)) {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        {status === "submitted"
          ? "Verification submitted"
          : "Verification confirming"}
      </span>
    );
  }

  if (["conflicted", "unavailable"].includes(status)) {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
        Verification status unavailable
      </span>
    );
  }

  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      <svg
        className="h-4 w-4 shrink-0 stroke-current"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        data-testid="unverified-icon"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <path d="M12 17h.01" />
      </svg>
      {status === "expired"
        ? "Verification expired"
        : status === "revoked"
          ? "Verification revoked"
          : status === "superseded"
            ? "Verification superseded"
            : "Not yet verified"}
    </span>
  );
}
