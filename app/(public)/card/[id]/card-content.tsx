import Image from "next/image";
import Link from "next/link";

import { formatDateTime, formatRelativeTime } from "@/lib/format/datetime";
import { formatPhoneDisplay, phoneHref } from "@/lib/format/phone";
import { OfflineEnvelopeSource } from "@/lib/emergency/offline-source";
import type { EmergencyCardRow } from "@/lib/supabase/types";

import { VerifiedBadge, type VerificationStatus } from "./verified-badge";

/**
 * Issue #600: low-literacy iconography.
 *
 * Inline, aria-hidden SVG glyphs paired with the existing text labels so
 * patients and community responders with low literacy can scan the card
 * faster. Icons are decorative only — the adjacent text is always rendered
 * and remains the accessible name, so screen readers and forced-colours
 * users lose nothing. `currentColor` keeps them legible in dark mode and
 * Windows High Contrast / forced-colours mode.
 */
function CategoryIcon({
  category,
  className = "h-5 w-5 shrink-0",
}: {
  category: "allergy" | "medication" | "condition" | "blood" | "genotype";
  className?: string;
}) {
  const common = {
    "aria-hidden": true as const,
    focusable: "false" as const,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };

  switch (category) {
    case "allergy":
      // Warning triangle with exclamation — universally read as "alert".
      return (
        <svg {...common}>
          <path d="M12 3 2 20h20L12 3Z" />
          <path d="M12 9v5" />
          <path d="M12 17h.01" />
        </svg>
      );
    case "medication":
      // Capsule / pill.
      return (
        <svg {...common}>
          <rect x="2" y="8" width="20" height="8" rx="4" />
          <path d="M12 8v8" />
        </svg>
      );
    case "condition":
      // Heart with a pulse line — chronic condition / implant.
      return (
        <svg {...common}>
          <path d="M12 20s-7-4.5-7-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7 3.5C19 15.5 12 20 12 20Z" />
          <path d="M5 12h3l1.5-2.5L12 14l1.5-2.5H19" />
        </svg>
      );
    case "blood":
      // Blood drop.
      return (
        <svg {...common}>
          <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
        </svg>
      );
    case "genotype":
      // DNA helix — genotype / sickle cell.
      return (
        <svg {...common}>
          <path d="M7 3c0 6 10 6 10 12M17 3c0 6-10 6-10 12M7 21c0-2 10-2 10-4M17 21c0-2-10-2-10-4" />
        </svg>
      );
  }
}

function formatList(values: string[] | null): string {
  if (values === null) return "Withheld by patient";
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

function formatAllergy(entry: AllergyEntry): string {
  const parts = [entry.substance_text];
  if (entry.reaction) parts.push(entry.reaction);
  if (entry.severity) parts.push(entry.severity);
  return parts.join(" — ");
}

function formatTime(value: string | null): string {
  return formatDateTime(value);
}

function formatRelative(value: string | null): string {
  return formatRelativeTime(value);
}

export function EmergencyCardContent({
  card,
  authorizationKind,
  isOwner = false,
}: {
  card: EmergencyCardRow;
  authorizationKind: "legacy" | "capability";
  /** Issue #383: true only when the signed-in viewer's own profile owns
   * this card — determined by the page without ever exposing the card's
   * user_id to the client (get_emergency_card deliberately never returns
   * it). Never trust this from anywhere but a server-side check. */
  isOwner?: boolean;
}) {
  const status: VerificationStatus =
    card.trust_state === "unverified"
      ? "not_verified"
      : (card.trust_state ?? "unavailable");

  const allergies = normaliseAllergies(card.allergies);
  const sortedAllergies =
    allergies === null ? null : sortByCriticality(allergies);
  const hasHighCriticality =
    sortedAllergies?.some((entry) => entry.criticality === "high") ?? false;

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
          <dl className="grid gap-2 rounded-lg border border-zinc-300 p-4 text-sm dark:border-zinc-700">
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Name</dt>
              <dd>{card.emergency_contact_name ?? "Not recorded"}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
              <dt className="font-medium">Phone</dt>
              <dd>
                {card.emergency_contact_phone ? (
                  <a
                    href={phoneHref(card.emergency_contact_phone)}
                    className="underline underline-offset-2"
                  >
                    {formatPhoneDisplay(card.emergency_contact_phone)}
                  </a>
                ) : (
                  "Not recorded"
                )}
              </dd>
            </div>
          </dl>
        </section>

        <OfflineEnvelopeSource
          cardId={card.id}
          authorizationKind={authorizationKind}
        />
      </main>
    </>
  );
}
