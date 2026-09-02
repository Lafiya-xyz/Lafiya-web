import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy — Lafiya",
  robots: { index: false, follow: false },
};

const LAST_UPDATED = "2026-07-17";
const VERSION = "1.0.0";

export default function PrivacyPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
      <div>
        <h1 className="text-3xl font-semibold text-zinc-950 dark:text-zinc-50">
          Privacy Policy
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Version {VERSION} · Last updated {LAST_UPDATED}
        </p>
      </div>

      <div className="flex flex-col gap-6 text-sm text-zinc-700 dark:text-zinc-300">
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            What we collect
          </h2>
          <p>
            Lafiya collects only the emergency-relevant subset of a
            patient&apos;s profile needed for first responders to make safe
            treatment decisions. This is:
          </p>
          <ul className="list-disc pl-5">
            <li>Name and age</li>
            <li>Photo (optional)</li>
            <li>Blood group and genotype</li>
            <li>Drug allergies</li>
            <li>Current medications</li>
            <li>Chronic conditions / implants</li>
            <li>Up to 3 emergency contacts (name, phone, relationship)</li>
            <li>Language spoken</li>
          </ul>
          <p>
            Nothing beyond this subset is exposed on the public emergency page.
            Full history, documents, and notes remain private behind
            authentication.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            Why we collect it
          </h2>
          <p>
            The data is collected solely to generate a scannable emergency card
            that speaks for the patient when they cannot. It is not used for
            advertising, profiling, or any purpose beyond that card.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            Where it is stored
          </h2>
          <p>
            Your data is stored in an encrypted Supabase Postgres database with
            Row-Level Security (RLS). Access is strictly controlled: patients
            can read and write only their own records, and the public emergency
            page exposes only the emergency subset via a dedicated read-only
            function.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            On-chain vs. off-chain
          </h2>
          <p>
            No personal health data ever touches the blockchain. Stellar holds
            only non-reversible hashes of records, attestation metadata (who
            verified the record and when), and USDC incentive payments. The
            actual health data remains off-chain in Supabase.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            Data retention
          </h2>
          <p>
            Your profile is retained until you request deletion. When you delete
            your account, your profile and associated data are permanently
            removed. Attestation hashes already recorded on-chain are immutable
            by design and cannot be erased, but they contain no health data.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            Your rights
          </h2>
          <p>
            You can export or delete your data at any time from the profile
            editor. If you need assistance exercising these rights, contact us
            through the support channels listed on the Lafiya Card.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">
            Contact
          </h2>
          <p>
            Lafiya is an open-source project. For privacy-related questions or
            concerns, open an issue at{" "}
            <a
              href="https://github.com/lafiya-xyz/lafiya-web/issues"
              className="underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/lafiya-xyz/lafiya-web
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
