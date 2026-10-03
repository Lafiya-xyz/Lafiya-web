"use client";

import { useEffect } from "react";

const STATUS_PAGE_URL =
  process.env.NEXT_PUBLIC_STATUS_PAGE_URL ?? "https://status.lafiya.health";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Only log the opaque digest in production — never the raw message or stack
    // which could leak internal implementation details to anyone with devtools open.
    if (process.env.NODE_ENV !== "production") {
      console.error("Unhandled application error", error);
    } else {
      console.error("Application error", { digest: error.digest });
    }
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 py-24 text-center dark:bg-black">
      <div className="w-full max-w-xl rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <p className="mb-4 text-sm font-medium tracking-[0.2em] text-zinc-500 uppercase dark:text-zinc-400">
          Something went wrong
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
          We couldn’t load this page right now.
        </h1>
        <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
          A problem interrupted the page. Please try again, and if it keeps
          happening, contact support so we can investigate.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-12 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
          >
            Try again
          </button>
          <a
            href={STATUS_PAGE_URL}
            className="inline-flex h-12 items-center justify-center rounded-full border border-zinc-300 px-6 text-base font-medium text-zinc-950 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Check system status
          </a>
        </div>
        <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
          Live service status is published independently at{" "}
          <a
            href={STATUS_PAGE_URL}
            className="font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
          >
            {STATUS_PAGE_URL.replace(/^https?:\/\//, "")}
          </a>
          .
        </p>
      </div>
    </div>
  );
}
