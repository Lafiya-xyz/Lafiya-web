"use client";

import QRCode from "qrcode";
import { useActionState, useEffect, useState } from "react";
import Image from "next/image";

import { createEmergencyCapability } from "./actions";
import { CopyLinkButton } from "./copy-link-button";

function formatDate(value: string | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

export function CapabilitySharePanel() {
  const [state, action, isPending] = useActionState(
    createEmergencyCapability,
    undefined,
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>();

  useEffect(() => {
    if (!state?.capabilityUrl) return;
    let active = true;
    QRCode.toDataURL(state.capabilityUrl, {
      errorCorrectionLevel: "Q",
      margin: 4,
      width: 400,
    })
      .then((url) => active && setQrDataUrl(url))
      .catch(() => active && setQrDataUrl(undefined));
    return () => {
      active = false;
    };
  }, [state?.capabilityUrl]);

  return (
    <section
      aria-labelledby="capability-share-heading"
      className="flex flex-col gap-4 rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"
    >
      <div>
        <h2 id="capability-share-heading" className="font-semibold">
          Current emergency QR
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          New QR links are high-entropy emergency capabilities. Their plain
          value is never stored by Lafiya and they expire after 180 days. Issue
          a replacement before expiry.
        </p>
      </div>
      <form action={action}>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full bg-zinc-950 px-5 py-2 text-sm font-medium text-white disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:focus:ring-zinc-600"
        >
          {isPending ? "Creating…" : "Create emergency QR"}
        </button>
      </form>
      {state?.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {state?.capabilityUrl ? (
        <div className="flex flex-col items-center gap-3 rounded-md bg-zinc-50 p-4 text-center dark:bg-zinc-900">
          {qrDataUrl ? (
            <Image
              src={qrDataUrl}
              unoptimized
              width={200}
              height={200}
              alt="QR code linking to your current emergency card"
            />
          ) : (
            <p className="text-sm">Preparing QR code…</p>
          )}
          <p className="max-w-full text-xs break-all text-zinc-600 dark:text-zinc-400">
            {state.capabilityUrl}
          </p>
          <CopyLinkButton text={state.capabilityUrl} />
          <p className="text-xs text-zinc-500">
            Valid until {formatDate(state.expiresAt)}. Anyone with this QR can
            view only the fields you allow on your emergency card.
          </p>
        </div>
      ) : null}
    </section>
  );
}
