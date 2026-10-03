"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { StepUpChallenge } from "../step-up-challenge";

/**
 * `next` is a plain browser navigation target (e.g. the export route
 * handler), not another app-router page, so verifying navigates with a
 * full document load (window.location) rather than router.push -- the
 * same way the caller originally reached this page.
 */
export function VerifyStepUpClient({ next }: { next: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(true);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {open
          ? "Waiting for verification…"
          : "Verification cancelled."}
      </p>

      {open ? (
        <StepUpChallenge
          onVerified={() => {
            window.location.href = next;
          }}
          onCancel={() => {
            setOpen(false);
            router.replace("/profile");
          }}
        />
      ) : null}
    </div>
  );
}
