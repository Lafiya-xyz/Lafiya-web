import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import Link from "next/link";

import { computeRecordHash } from "@/lib/attestation/recordHash";
import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";
import { getAttestation } from "@/lib/stellar/attestation";

import { VerifiedBadge, type VerificationStatus } from "./verified-badge";

// Caching strategy: this page is ISR with a short TTL rather than
// force-dynamic. Card data changes rarely (only when a patient edits their
// profile). Between edits, a 60s stale window is acceptable for emergency
// info. On profile save, upsertProfile explicitly revalidates this path so
// edits appear immediately to the next scan.
export const revalidate = 60;

// This page is unauthenticated and reachable by anyone with the link (that's
// the point — a responder scanning a QR shouldn't need to log in), but it
// must never be indexed or crawled.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None recorded";
}

export default async function PublicCardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_emergency_card", {
    p_card_id: id,
  });

  if (error) {
    console.error("[PublicCardPage] failed to load emergency card", {
      cardPublicId: id,
      error,
    });
    throw new Error("UNAVAILABLE");
  }

  if (!data || data.length === 0) {
    notFound();
  }

  const card = data[0];
  const recordHash = computeRecordHash(card);

  let status: VerificationStatus;
  try {
    const attestation = await getAttestation(recordHash);
    status = attestation !== null ? "verified" : "not_verified";
  } catch (err) {
    logError("Failed to retrieve attestation from Stellar", err, {
      route: "/card/[id]",
      recordHash,
    });
    status = "unavailable";
  }

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4 focus:text-black dark:focus:bg-black dark:focus:text-white"
      >
        Skip to main content
      </a>
      <main
        id="main-content"
        className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16"
      >
        <VerifiedBadge status={status} />

        <div className="flex items-center gap-4">
          {card.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- unknown remote host per-card, not worth allowlisting
            <img
              src={card.photo_url}
              alt=""
              width={80}
              height={80}
              className="h-20 w-20 rounded-full object-cover"
            />
          ) : null}
          <div>
            <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
              {card.name}
            </h1>
            {card.age !== null ? (
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {card.age} years old
              </p>
            ) : null}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-4 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
          <div>
            <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Blood group
            </dt>
            <dd className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
              {card.blood_group}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
              Genotype
            </dt>
            <dd className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
              {card.genotype}
            </dd>
          </div>
        </dl>

        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Allergies
          </h2>
          <p className="text-zinc-950 dark:text-zinc-50">
            {formatList(card.allergies)}
          </p>
        </div>

        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Current medications
          </h2>
          <p className="text-zinc-950 dark:text-zinc-50">
            {formatList(card.medications)}
          </p>
        </div>

        <div>
          <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Chronic conditions / implants
          </h2>
          <p className="text-zinc-950 dark:text-zinc-50">
            {formatList(card.chronic_conditions)}
          </p>
        </div>

        {card.emergency_contacts.length > 0 ? (
          <div>
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Emergency contacts
            </h2>
            <ul role="list" className="flex flex-col gap-1">
              {card.emergency_contacts.map((contact) => (
                <li
                  key={`${contact.name}-${contact.phone}`}
                  className="text-zinc-950 dark:text-zinc-50"
                >
                  {contact.name} ({contact.relationship}) — {contact.phone}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {card.language ? (
          <div>
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Language spoken
            </h2>
            <p className="text-zinc-950 dark:text-zinc-50">{card.language}</p>
          </div>
        ) : null}

        <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-500">
          Not a medical device. Not a substitute for professional medical
          judgment.
        </p>
      </main>
    </>
  );
}
