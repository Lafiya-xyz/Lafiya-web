"use client";

import { useEffect, useState } from "react";

const DISMISS_KEY = "lafiya:critical-fields-banner-dismissed";

/**
 * Blood group and allergies are the fields an emergency responder is most
 * likely to need immediately. This banner is deliberately separate from
 * any generic profile-completeness indicator so it can't get diluted among
 * lower-stakes missing fields. Dismissal is stored in sessionStorage (not
 * localStorage) so it clears itself and re-warns on the next visit rather
 * than being silenced forever after one dismissal.
 */
export function CriticalFieldsBanner({
  bloodGroupMissing,
  allergiesMissing,
}: {
  bloodGroupMissing: boolean;
  allergiesMissing: boolean;
}) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.sessionStorage.getItem(DISMISS_KEY) === "true");
  }, []);

  if (!bloodGroupMissing && !allergiesMissing) {
    return null;
  }
  if (dismissed) {
    return null;
  }

  const missingFields = [
    bloodGroupMissing ? "blood group" : null,
    allergiesMissing ? "allergies" : null,
  ].filter((field): field is string => field !== null);

  const missingFieldsText = missingFields.join(" and ");
  const verb = missingFields.length > 1 ? "are" : "is";

  return (
    <div
      role="alert"
      className="rounded-md border border-red-500/40 bg-red-50 p-4 text-sm text-red-900 dark:border-red-400/40 dark:bg-red-950/30 dark:text-red-100"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium">Missing critical emergency info</p>
          <p className="mt-1">
            Your {missingFieldsText} {verb} not set. Emergency responders
            rely on this information most — please fill it in below.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            window.sessionStorage.setItem(DISMISS_KEY, "true");
            setDismissed(true);
          }}
          aria-label="Dismiss missing critical info warning"
          className="shrink-0 rounded-md px-2 text-red-700 transition-colors hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
