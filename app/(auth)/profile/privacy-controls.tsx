import type { ConsentEventRow, DisclosurePolicy } from "@/lib/supabase/types";

import { recordConsentChoice, updateDisclosureChoices } from "./actions";

const purposes = [
  ["emergency_public_disclosure", "Public emergency card"],
  ["offline_caching", "Offline caching on responder devices"],
  ["clinical_verification", "Clinical verification"],
  ["optional_analytics", "Optional analytics"],
] as const;

const disclosureFields = [
  "name",
  "age",
  "photo_url",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
  "emergency_contacts",
  "language",
] as const;

export function PrivacyControls({
  revisionId,
  policy,
  events,
}: {
  revisionId: string;
  policy: DisclosurePolicy;
  events: ConsentEventRow[];
}) {
  const latest = new Map<string, ConsentEventRow>();
  for (const event of events)
    if (!latest.has(event.purpose)) latest.set(event.purpose, event);
  return (
    <section
      aria-labelledby="privacy-controls-heading"
      className="flex flex-col gap-6 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"
    >
      <div>
        <h2 id="privacy-controls-heading" className="font-semibold">
          Privacy and consent
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Choose future uses of your data. Withdrawal does not erase historical
          consent events.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {purposes.map(([purpose, label]) => {
          const active = latest.get(purpose)?.action === "acknowledged";
          return (
            <form
              action={recordConsentChoice}
              key={purpose}
              className="flex items-center justify-between gap-4"
            >
              <input type="hidden" name="purpose" value={purpose} />
              <input
                type="hidden"
                name="action"
                value={active ? "withdrawn" : "acknowledged"}
              />
              <span>
                {label}{" "}
                <span className="text-xs text-zinc-500">
                  ({active ? "allowed" : "withdrawn"})
                </span>
              </span>
              <button className="rounded-full border px-4 py-2 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:focus:ring-zinc-600" type="submit">
                {active ? "Withdraw" : "Allow"}
              </button>
            </form>
          );
        })}
      </div>
      <form action={updateDisclosureChoices} className="flex flex-col gap-3">
        <input type="hidden" name="expectedRevisionId" value={revisionId} />
        <fieldset>
          <legend className="font-medium">
            Fields visible on the public card
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {disclosureFields.map((field) => (
              <label key={field} className="flex gap-2">
                <input
                  type="checkbox"
                  name={`field:${field}`}
                  defaultChecked={policy.fields[field]}
                  className="focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 dark:focus:ring-zinc-600"
                />
                <span>{field.replaceAll("_", " ")}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button
          className="self-start rounded-full bg-zinc-950 px-5 py-2 text-white focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:focus:ring-zinc-600"
          type="submit"
        >
          Save disclosure choices
        </button>
      </form>
      <div>
        <h3 className="font-medium">Consent history</h3>
        <ol className="mt-2 max-h-48 overflow-auto text-sm">
          {events.map((event) => (
            <li key={event.id}>
              {event.purpose.replaceAll("_", " ")} — {event.action} —{" "}
              <time dateTime={event.occurred_at}>
                {new Date(event.occurred_at).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
