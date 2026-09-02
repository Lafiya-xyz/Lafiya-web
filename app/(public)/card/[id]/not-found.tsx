import type { Metadata } from "next";

// Handles both a malformed id and a well-formed id that doesn't match any
// card. The message is identical either way so this route can never be used
// to distinguish "wrong format" from "right format, wrong value" -- that
// distinction is exactly what would make it useful for enumerating IDs.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CardNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="rounded-lg border border-zinc-300 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          This card could not be found.
        </p>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
          The link may be mistyped or no longer valid. Please check the link
          or ask the person who shared it with you for a new one.
        </p>
      </div>
    </div>
  );
}
