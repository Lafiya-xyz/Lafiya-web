import type { EmergencyRecordData } from "@/lib/records/canonicalization";

/**
 * Issue #384: a patient should be able to notice if critical fields
 * (blood group, allergies, medications) were changed unexpectedly — their
 * own accidental edit, or worse, unauthorized access. No email
 * infrastructure exists anywhere in this project (checked: no resend/
 * nodemailer/sendgrid dependency, no lib/email module), so this is
 * scoped down to the honest minimal version the issue itself suggests: an
 * in-app "last change" note, sourced from record_revisions — which
 * already stores a full historical snapshot per edit, so no new storage
 * is needed for this.
 */

const CRITICAL_FIELDS = [
  "blood_group",
  "allergies",
  "medications",
] as const satisfies readonly (keyof EmergencyRecordData)[];

const FIELD_LABELS: Record<(typeof CRITICAL_FIELDS)[number], string> = {
  blood_group: "blood group",
  allergies: "allergies",
  medications: "medications",
};

function changedCriticalFields(
  previous: EmergencyRecordData,
  current: EmergencyRecordData,
): string[] {
  return CRITICAL_FIELDS.filter((field) => {
    const a = previous[field];
    const b = current[field];
    if (Array.isArray(a) && Array.isArray(b)) {
      return (
        a.length !== b.length || a.some((value, i) => value !== b[i])
      );
    }
    return a !== b;
  }).map((field) => FIELD_LABELS[field]);
}

export interface RevisionSnapshot {
  created_at: string;
  emergency_data: EmergencyRecordData;
}

export function LastChangeNotice({
  latest,
  previous,
}: {
  latest: RevisionSnapshot;
  previous: RevisionSnapshot | null;
}) {
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(latest.created_at));

  if (!previous) {
    return (
      <p className="text-xs text-zinc-500">
        Profile created: {formattedDate}
      </p>
    );
  }

  const changedFields = changedCriticalFields(
    previous.emergency_data,
    latest.emergency_data,
  );
  const criticalChange = changedFields.length > 0;

  return (
    <p
      role={criticalChange ? "status" : undefined}
      className={
        criticalChange
          ? "rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
          : "text-xs text-zinc-500"
      }
    >
      Last change: {formattedDate}
      {criticalChange
        ? ` — updated ${changedFields.join(", ")}. If you didn't make this change, review your account security.`
        : null}
    </p>
  );
}
