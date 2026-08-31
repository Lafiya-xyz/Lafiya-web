import type { Metadata } from "next";

// Malformed and unknown tokens are indistinguishable, so this message never
// hints at which one occurred.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CapabilityCardNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="rounded-lg border border-zinc-300 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          This link could not be found.
        </p>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
          The link may be mistyped. Please double-check it or ask the patient
          for a new one.
        </p>
      </div>
    </div>
  );
}
