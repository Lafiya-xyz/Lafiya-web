import Image from "next/image";

import { OfflineEnvelopeSource } from "@/lib/emergency/offline-source";
import type { EmergencyCardRow } from "@/lib/supabase/types";

import { VerifiedBadge, type VerificationStatus } from "./verified-badge";

function formatList(values: string[] | null): string {
  if (values === null) return "Withheld by patient";
  return values.length > 0 ? values.join(", ") : "None recorded";
}

function formatTime(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function phoneHref(phone: string): string | null {
  const normalized = phone.replace(/[\s().-]/g, "");
  return /^\+?[1-9]\d{6,14}$/.test(normalized) ? `tel:${normalized}` : null;
}

export function EmergencyCardContent({
  card,
  authorizationKind,
}: {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
}) {
  const status: VerificationStatus =
    card.trust_state === "unverified"
      ? "not_verified"
      : (card.trust_state ?? "unavailable");

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4 focus:text-black dark:focus:bg-black dark:focus:text-white"
      >
        Skip to emergency information
      </a>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-16"
      >
        <section
          aria-label="Record trust and freshness"
          className="flex flex-col gap-3"
        >
          <VerifiedBadge status={status} />
          <dl className="grid gap-2 rounded-lg border border-zinc-300 p-3 text-sm dark:border-zinc-700">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Record updated</dt>
              <dd>{formatTime(card.record_updated_at)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Authorization valid until</dt>
              <dd>{formatTime(card.authorization_expires_at)}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Verification last checked</dt>
              <dd>{formatTime(card.trust_updated_at)}</dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="identity-heading"
          className="flex items-center gap-4"
        >
          {card.photo_url ? (
            <Image
              src={card.photo_url}
              alt=""
              width={80}
              height={80}
              sizes="80px"
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : null}
          <div>
            <h1
              id="identity-heading"
              className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50"
            >
              {card.name ?? "Name withheld"}
            </h1>
            {card.age !== null ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {card.age} years old
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="critical-facts-heading">
          <h2
            id="critical-facts-heading"
            className="mb-3 text-lg font-semibold"
          >
            Critical emergency information
          </h2>
          <dl className="grid gap-4 rounded-lg border border-zinc-300 p-4 sm:grid-cols-2 dark:border-zinc-700">
            <div>
              <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                Blood group
              </dt>
              <dd className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
                {card.blood_group ?? "Withheld"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                Genotype
              </dt>
              <dd className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
                {card.genotype ?? "Withheld"}
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="clinical-details-heading"
          className="flex flex-col gap-5"
        >
          <h2 id="clinical-details-heading" className="sr-only">
            Clinical details
          </h2>
          <CardField label="Allergies" value={formatList(card.allergies)} />
          <CardField
            label="Current medications"
            value={formatList(card.medications)}
          />
          <CardField
            label="Chronic conditions / implants"
            value={formatList(card.chronic_conditions)}
          />
        </section>

        {card.emergency_contacts === null ? (
          <CardField label="Emergency contacts" value="Withheld by patient" />
        ) : card.emergency_contacts.length > 0 ? (
          <section aria-labelledby="contacts-heading">
            <h2
              id="contacts-heading"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Emergency contacts
            </h2>
            <ul role="list" className="mt-2 flex flex-col gap-3">
              {card.emergency_contacts.map((contact) => {
                const href = phoneHref(contact.phone);
                return (
                  <li
                    key={`${contact.name}-${contact.phone}`}
                    className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <p className="font-medium text-zinc-950 dark:text-zinc-50">
                      {contact.name}
                    </p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {contact.relationship}
                    </p>
                    {href ? (
                      <a
                        href={href}
                        className="mt-2 inline-flex min-h-11 items-center rounded-full bg-zinc-950 px-4 text-sm font-medium text-white underline-offset-2 hover:underline dark:bg-zinc-50 dark:text-zinc-950"
                      >
                        Call {contact.phone}
                      </a>
                    ) : (
                      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                        Phone number unavailable
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {card.language ? (
          <CardField label="Language spoken" value={card.language} />
        ) : null}
        <p
          role="note"
          className="mt-4 text-xs text-zinc-500 dark:text-zinc-500"
        >
          Lafiya is pre-alpha software on the Stellar testnet, not yet
          audited, and not a medical device. Not a substitute for
          professional medical judgment.
        </p>
      </main>
      <OfflineEnvelopeSource
        card={card}
        authorizationKind={authorizationKind}
      />
    </>
  );
}

function CardField({ label, value }: { label: string; value: string }) {
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </h2>
      <p className="text-zinc-950 dark:text-zinc-50">{value}</p>
    </section>
  );
}
