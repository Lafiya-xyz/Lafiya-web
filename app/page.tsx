import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-6 py-24 dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 text-center">
        <p className="text-sm font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          Pre-alpha · Stellar testnet
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-zinc-950 sm:text-5xl dark:text-zinc-50">
          Your vitals, verified.
        </h1>
        <p className="max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          Lafiya is a free, patient-owned emergency health card. Blood group,
          genotype, allergies, and current medications travel with you as a
          scannable QR code, work offline, and can be cryptographically verified
          by a health worker.
        </p>
        <div className="flex flex-col gap-4 sm:flex-row">
          <Link
            href="/signup"
            className="flex h-12 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
          >
            Create your card
          </Link>
          <Link
            href="/signin"
            className="flex h-12 items-center justify-center rounded-full border border-zinc-300 px-6 text-base font-medium text-zinc-950 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
          >
            Sign in
          </Link>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-500">
          Not a medical device. Not a substitute for professional medical
          judgment.
        </p>
      </main>
    </div>
  );
}
