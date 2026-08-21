"use client";

import type { ReactNode } from "react";

type UnavailableStateProps = {
  reset: () => void;
};

function UnavailableState({ reset }: UnavailableStateProps) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-center dark:border-amber-700 dark:bg-amber-950/40">
        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          This emergency card is temporarily unavailable.
        </p>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
          We could not load this right now. Please try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

export default function CardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  if (error.message === "UNAVAILABLE") {
    return <UnavailableState reset={reset} />;
  }

  throw error;
}
