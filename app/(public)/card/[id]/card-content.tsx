import { parsePhoneNumberFromString } from "libphonenumber-js";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { formatDateTime, formatRelativeTime } from "@/lib/format/datetime";
import { formatPhoneDisplay, phoneHref } from "@/lib/format/phone";
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

/**
 * Issue #602: structured allergy entries.
 *
 * Allergies are no longer plain tag strings. Each entry carries a coded
 * substance (with a free-text fallback), a reaction, a severity and a
 * criticality. The card sorts by criticality so life-threatening allergies
 * (e.g. anaphylaxis to penicillin) surface first, and shows a banner when
 * any high-criticality allergy is present.
 */
type AllergyCriticality = "low" | "high" | "unable-to-assess";

type AllergyEntry = {
  substance_text: string;
  coded: { system: string; code: string; display: string } | null;
  reaction: string | null;
  severity: "mild" | "moderate" | "severe" | null;
  criticality: AllergyCriticality;
};

const CRITICALITY_ORDER: Record<AllergyCriticality, number> = {
  high: 0,
  "unable-to-assess": 1,
  low: 2,
};

function isAllergyEntry(value: unknown): value is AllergyEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.substance_text === "string";
}

/**
 * Normalises the stored allergies value. New rows are structured entries;
 * legacy rows may still be plain strings (pre-migration) and are treated as
 * `{substance_text, coded: null}` so nothing is lost on the card.
 */
function normaliseAllergies(value: unknown): AllergyEntry[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    if (typeof item === "string") {
      return {
        substance_text: item,
        coded: null,
        reaction: null,
        severity: null,
        criticality: "unable-to-assess" as const,
      };
    }
    if (isAllergyEntry(item)) {
      return {
        substance_text: item.substance_text,
        coded: item.coded ?? null,
        reaction: item.reaction ?? null,
        severity: item.severity ?? null,
        criticality: item.criticality ?? "unable-to-assess",
      };
    }
    return {
      substance_text: String(item),
      coded: null,
      reaction: null,
      severity: null,
      criticality: "unable-to-assess" as const,
    };
  });
}

function sortByCriticality(entries: AllergyEntry[]): AllergyEntry[] {
  return [...entries].sort(
    (a, b) =>
      CRITICALITY_ORDER[a.criticality] - CRITICALITY_ORDER[b.criticality],
  );
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
              <dd>{formatRelative(card.record_updated_at)}</dd>
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

        {hasHighCriticality ? (
          <p
            role="alert"
            data-testid="card-allergy-critical-banner"
            className="rounded-lg border border-red-600 bg-red-50 p-3 text-sm font-semibold text-red-800 dark:border-red-500 dark:bg-red-950 dark:text-red-200"
          >
            ⚠ Life-threatening allergy on record — check before giving any
            medication.
          </p>
        ) : null}

        <section aria-labelledby="critical-facts-heading">
          <h2
            id="critical-facts-heading"
            className="mb-3 text-lg font-semibold"
          >
            Critical emergency information
          </h2>
          <dl className="grid gap-4 rounded-lg border border-zinc-300 p-4 sm:grid-cols-2 dark:border-zinc-700">
            <div>
              <dt className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                <CategoryIcon category="allergy" />
                Allergies
              </dt>
              <dd className="mt-1 text-sm">
                {sortedAllergies === null ? (
                  "Withheld by patient"
                ) : sortedAllergies.length === 0 ? (
                  "None recorded"
                ) : (
                  <ul className="flex flex-col gap-1">
                    {sortedAllergies.map((entry, index) => (
                      <li
                        key={`${entry.substance_text}-${index}`}
                        className={
                          entry.criticality === "high"
                            ? "font-semibold text-red-700 dark:text-red-300"
                            : undefined
                        }
                      >
                        {formatAllergy(entry)}
                        {entry.criticality === "high" ? (
                          <span className="sr-only"> (life-threatening)</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                <CategoryIcon category="medication" />
                Medications
              </dt>
              <dd className="mt-1 text-sm">{formatList(card.medications)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                <CategoryIcon category="condition" />
                Conditions
              </dt>
              <dd className="mt-1 text-sm">{formatList(card.conditions)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                <CategoryIcon category="blood" />
                Blood group
              </dt>
              <dd className="mt-1 text-sm">
                {card.blood_group ?? "Not recorded"}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                <CategoryIcon category="genotype" />
                Genotype
              </dt>
              <dd className="mt-1 text-sm">
                {card.genotype ?? "Not recorded"}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="contact-heading">
          <h2 id="contact-heading" className="mb-3 text-lg font-semibold">
            Emergency contact
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
