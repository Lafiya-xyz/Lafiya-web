import { getConsentHistory, type ConsentHistoryEntry } from "./consent/actions";
import {
  CURRENT_POLICY_VERSION,
  CURRENT_POLICY_LABEL,
  POLICY_ROUTES,
} from "@/lib/consent";
import { AcknowledgeConsentButton } from "./acknowledge-consent-button";

function formatAcceptedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/**
 * Presentational consent-history section. Pure (no server-only imports) so it
 * can be unit-tested directly; the server wrapper below feeds it live data.
 */
export function ConsentHistoryView({
  history,
  currentVersion,
  currentLabel,
  needsAcknowledgement,
  termsRoute,
  privacyRoute,
}: {
  history: ConsentHistoryEntry[];
  currentVersion: string;
  currentLabel: string;
  needsAcknowledgement: boolean;
  termsRoute: string;
  privacyRoute: string;
}) {
  return (
    <section
      aria-labelledby="consent-history-heading"
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <h2
        id="consent-history-heading"
        className="text-lg font-semibold text-zinc-950 dark:text-zinc-50"
      >
        Consent history
      </h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        You can review the data-processing consent you have granted under our{" "}
        <a className="underline focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none rounded px-1 dark:focus:ring-zinc-600" href={termsRoute}>
          Terms
        </a>{" "}
        and{" "}
        <a className="underline focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none rounded px-1 dark:focus:ring-zinc-600" href={privacyRoute}>
          Privacy Policy
        </a>
        .
      </p>

      {history.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          No consent recorded yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {history.map((entry) => (
            <li
              key={entry.policyVersion}
              className="flex items-center justify-between"
            >
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                {entry.policyVersion}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">
                accepted {formatAcceptedAt(entry.acceptedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {needsAcknowledgement ? (
        <div className="flex flex-col gap-2 rounded-md bg-amber-50 p-3 dark:bg-amber-950/40">
          <p className="text-sm text-amber-900 dark:text-amber-200">
            A new privacy policy ({currentLabel}, version {currentVersion}) is
            active. Please acknowledge it to confirm your consent.
          </p>
          <AcknowledgeConsentButton />
        </div>
      ) : (
        <p className="text-sm text-green-700 dark:text-green-400">
          You have acknowledged the current policy (version {currentVersion}).
        </p>
      )}
    </section>
  );
}

/**
 * Server component: loads the signed-in user's consent history and renders
 * the view, prompting for acknowledgement only when the current policy version
 * has not yet been recorded.
 */
export default async function ConsentHistory() {
  const history = await getConsentHistory();
  const needsAcknowledgement = !history.some(
    (entry) => entry.policyVersion === CURRENT_POLICY_VERSION,
  );

  return (
    <ConsentHistoryView
      history={history}
      currentVersion={CURRENT_POLICY_VERSION}
      currentLabel={CURRENT_POLICY_LABEL}
      needsAcknowledgement={needsAcknowledgement}
      termsRoute={POLICY_ROUTES.terms}
      privacyRoute={POLICY_ROUTES.privacy}
    />
  );
}
