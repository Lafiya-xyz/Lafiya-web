import { parsePhoneNumberFromString } from "libphonenumber-js";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatDateTime } from "@/lib/format/datetime";
import { OfflineEnvelopeSource } from "@/lib/emergency/offline-source";
import type { EmergencyCardRow } from "@/lib/supabase/types";

import { NotifyContactsForm } from "../c/[token]/notify-contacts-form";
import { VerifiedBadge, type VerificationStatus } from "./verified-badge";
import { ReadAloud } from "./read-aloud";

function formatList(values: string[] | null, pinRequired = false): string {
  if (values === null) {
    return pinRequired ? "Requires the card PIN" : "Withheld by patient";
  }
  return values.length > 0 ? values.join(", ") : "None recorded";
}

function formatTime(value: string | null): string {
  return formatDateTime(value);
}

function formatRelativeTime(value: string | null): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "Just now";
  if (diffMinutes < 60)
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date);
}

type ContactLinks = {
  tel: string;
  sms: string;
  whatsapp: string;
};

/**
 * Contact numbers are already normalized to E.164 at save time (see
 * lib/records/canonicalization.ts), but older records may predate that
 * normalization, so this re-parses defensively (default region "NG",
 * matching the rest of the app) rather than trusting the stored format.
 * Returns null for anything that still can't be parsed as a valid number,
 * which hides the one-tap actions for that contact instead of emitting a
 * broken link.
 */
function contactLinks(phone: string, patientName: string): ContactLinks | null {
  const parsed = parsePhoneNumberFromString(phone, "NG");
  if (!parsed?.isValid()) return null;

  const e164 = parsed.number;
  const digits = e164.slice(1); // wa.me expects digits only, no leading "+"
  const message = encodeURIComponent(
    `I'm a responder for ${patientName}. Please call me back.`,
  );

  return {
    tel: `tel:${e164}`,
    sms: `sms:${e164}?&body=${message}`,
    whatsapp: `https://wa.me/${digits}?text=${message}`,
  };
}

const actionButtonClassName =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-zinc-950 px-4 text-sm font-medium text-zinc-950 underline-offset-2 hover:underline focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-50 dark:text-zinc-50 dark:focus:ring-zinc-600";

export function EmergencyCardContent({
  card,
  authorizationKind,
  pinGate,
  isOwner = false,
  signedPhotoUrl,
}: {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
  /** Issue #383: true only when the signed-in viewer's own profile owns
   * this card — determined by the page without ever exposing the card's
   * user_id to the client (get_emergency_card deliberately never returns
   * it). Never trust this from anywhere but a server-side check. */
  isOwner?: boolean;
  /** Issue #631: the PIN entry form, shown when fields are PIN-gated. */
  pinGate?: ReactNode;
}) {
  const locale = labelLocale ?? negotiateLabelLocale(acceptLanguage);
  const t = GLOSSARY[locale];
  const patientLang = card.language ?? null;
  const status: VerificationStatus =
    card.trust_state === "unverified"
      ? "not_verified"
      : (card.trust_state ?? "unavailable");

  const medications = formatMedications(
    (card.medications as unknown[] | null) ?? null,
  );

  return (
    <>
      {/* A skip link outside every landmark fails axe's "region" rule
          (all page content must be contained by a landmark), so it gets its
          own nav landmark rather than sitting bare before <main>. */}
      <nav aria-label="Skip links">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4 focus:text-black dark:focus:bg-black dark:focus:text-white"
        >
          Skip to emergency information
        </a>
      </nav>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-16"
      >
        {isOwner ? (
          <Link
            href="/profile"
            className="self-start rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            ✎ Edit my card
          </Link>
        ) : null}
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
              <dt className="font-medium">Last updated</dt>
              <dd>{formatRelativeTime(card.record_updated_at)}</dd>
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
          {signedPhotoUrl ? (
            <Image
              src={signedPhotoUrl}
              alt=""
              width={80}
              height={80}
              sizes="80px"
              // Issue #528: signed URLs change per-request; disable Next.js
              // image optimization so the optimizer never caches or rewrites them.
              unoptimized
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : null}
          <div>
            <h1
              id="identity-heading"
              data-testid="card-identity-name"
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
              <dd
                data-testid="card-blood-group"
                className="text-lg font-semibold text-zinc-950 dark:text-zinc-50"
              >
                {card.blood_group ?? "Withheld"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
                Genotype
              </dt>
              <dd
                data-testid="card-genotype"
                className="text-lg font-semibold text-zinc-950 dark:text-zinc-50"
              >
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
          <CardField
            label="Allergies"
            value={formatList(card.allergies)}
            changedAt={card.allergies_changed_at}
          />
          <CardField
            label="Current medications"
            value={formatList(
              card.medications,
              card.disclosure_states?.medications === "pin_required",
            )}
          />
          <CardField
            label="Chronic conditions / implants"
            value={formatList(
              card.chronic_conditions,
              card.disclosure_states?.chronic_conditions === "pin_required",
            )}
          />
        </section>

        {pinGate}

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
                const links = contactLinks(
                  contact.phone,
                  card.name ?? "the patient",
                );
                return (
                  <li
                    key={`${contact.name}-${contact.phone}`}
                    className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <p className="font-medium">{contact.name}</p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {contact.relationship}
                    </p>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {contact.phone}
                    </p>
                    {links ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <a
                          href={links.tel}
                          aria-label={`Call ${contact.name}`}
                          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-zinc-950 px-4 text-sm font-medium text-white underline-offset-2 hover:underline focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:focus:ring-zinc-600"
                        >
                          Call
                        </a>
                        <a
                          href={links.sms}
                          aria-label={`Text ${contact.name}`}
                          className={actionButtonClassName}
                        >
                          Text
                        </a>
                        <a
                          href={links.whatsapp}
                          aria-label={`WhatsApp ${contact.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={actionButtonClassName}
                        >
                          WhatsApp
                        </a>
                      </div>
                    ) : (
                      <p className="text-sm">{contact.phone}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <CardField label="Emergency contacts" value="None recorded" />
        )}

        {capabilityToken && card.emergency_contacts?.length ? (
          <NotifyContactsForm token={capabilityToken} />
        ) : null}

        <OfflineEnvelopeSource
          cardId={card.id}
          authorizationKind={authorizationKind}
        />
      </main>
    </>
  );
}

function CardField({
  label,
  value,
  changedAt,
}: {
  label: string;
  value: string;
  /** Issue #544: server-projected revision timestamp for this field, or
   * undefined when the field is not tracked / never changed. */
  changedAt?: string | null;
}) {
  const recentlyChanged = isRecentlyChanged(changedAt);
  return (
    <div>
      <dt className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </dt>
      <dd className="mt-1 text-zinc-950 dark:text-zinc-50">
        {value}
        {recentlyChanged ? (
          <span
            data-testid={`card-recent-change-${label
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")}`}
            className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-300"
          >
            {/* Icon + text so the marker never relies on colour alone. */}
            <span aria-hidden="true">⟳</span>
            <span>
              Recently updated — {formatTime(changedAt ?? null)}
            </span>
          </span>
        ) : null}
      </dd>
    </div>
  );
}
