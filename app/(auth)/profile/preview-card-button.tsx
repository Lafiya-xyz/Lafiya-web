"use client";

import { useTransition } from "react";

export function PreviewCardButton({ cardUrl }: { cardUrl: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() =>
        startTransition(() => {
          window.open(cardUrl, "_blank");
        })
      }
      disabled={isPending}
      className="flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
    >
      {isPending ? "Opening preview…" : "Preview card"}
    </button>
  );
}
