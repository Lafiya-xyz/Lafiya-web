import type { ConsentLogRow } from "@/lib/supabase/types";
import { CURRENT_POLICY_VERSION } from "@/lib/consent/policy";

import { ConsentAcknowledgementForm } from "./consent-acknowledgement-form";

const consentDateFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function ConsentHistory({ logs }: { logs: ConsentLogRow[] }) {
  const hasCurrentPolicy = logs.some(
    (log) => log.policy_version === CURRENT_POLICY_VERSION,
  );

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div>
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
          Consent history
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Policy versions you have acknowledged for Lafiya data processing.
        </p>
      </div>

      {logs.length > 0 ? (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {logs.map((log) => (
            <li key={log.id} className="flex items-center justify-between gap-4 py-3 text-sm">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {log.policy_version}
              </span>
              <time
                dateTime={log.accepted_at}
                className="text-zinc-600 dark:text-zinc-400"
              >
                {consentDateFormatter.format(new Date(log.accepted_at))} UTC
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No consent acknowledgements recorded yet.
        </p>
      )}

      {hasCurrentPolicy ? (
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          Current policy acknowledged.
        </p>
      ) : (
        <ConsentAcknowledgementForm />
      )}
    </section>
  );
}
