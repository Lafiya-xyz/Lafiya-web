"use client";

import { useState } from "react";

export function CopyLinkButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
    >
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
