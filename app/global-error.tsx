"use client";

import { useEffect } from "react";

export default function GlobalError({
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
      console.error("Unhandled global application error", error);
    } else {
      console.error("Global application error", { digest: error.digest });
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 py-24 text-center dark:bg-black">
          <div className="w-full max-w-xl rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
              Critical error
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
              We hit a problem while starting this page.
            </h1>
            <p className="mt-4 text-base leading-7 text-zinc-600 dark:text-zinc-400">
              The application could not render correctly. Please try again. If the issue
              persists, contact support with the time this happened.
            </p>
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={reset}
                className="inline-flex h-12 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
