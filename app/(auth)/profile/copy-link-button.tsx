"use client";

import { useEffect, useState } from "react";

export function CopyLinkButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timeout);
  }, [copied]);

  async function handleClick() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
      <div aria-live="polite" className="sr-only">
        {copied ? "Link copied to clipboard" : null}
      </div>
      {copied ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white shadow-lg dark:bg-zinc-50 dark:text-zinc-950"
        >
          Link copied to clipboard
        </div>
      ) : null}
    </>
  );
}
