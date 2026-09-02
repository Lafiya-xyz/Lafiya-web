"use client";

import QRCode from "qrcode";
import { useActionState, useEffect, useState } from "react";
import Image from "next/image";

import {
  createEmergencyCapability,
  revokeEmergencyCapability,
} from "./actions";
import { CopyLinkButton } from "./copy-link-button";

function formatDate(value: string | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}

interface ActiveCapability {
  id: string;
  purpose: "emergency" | "temporary";
  field_allowlist: Record<string, boolean>;
  issued_at: string;
  expires_at: string;
  max_views: number | null;
  used_views: number;
}

/**
 * Issue #385: one active share, with its own revoke button. `field_allowlist`
 * is what "scope" means for this model — capabilities are anonymous bearer
 * tokens, not grants to a named person, so there's no "recipient" to show;
 * the fields it discloses and its purpose/expiry are the real scope.
 */
function ActiveCapabilityRow({ capability }: { capability: ActiveCapability }) {
  const [state, action, isPending] = useActionState(
    revokeEmergencyCapability,
    undefined,
  );
  const revoked = state?.revokedId === capability.id;
  const disclosedFields = Object.entries(capability.field_allowlist)
    .filter(([, allowed]) => allowed)
    .map(([field]) => field.replace(/_/g, " "))
    .join(", ");

  if (revoked) return null;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium capitalize">{capability.purpose} share</p>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Issued {formatDate(capability.issued_at)} · expires{" "}
          {formatDate(capability.expires_at)}
          {capability.max_views != null
            ? ` · ${capability.used_views}/${capability.max_views} views used`
            : ` · ${capability.used_views} view${capability.used_views === 1 ? "" : "s"} so far`}
        </p>
        {disclosedFields ? (
          <p className="mt-1 text-xs text-zinc-500">
            Discloses: {disclosedFields}
          </p>
        ) : null}
      </div>
      <form action={action} className="shrink-0">
        <input type="hidden" name="capabilityId" value={capability.id} />
        <button
          type="submit"
          disabled={isPending}
          className="rounded-full border border-red-600 px-4 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-400 dark:text-red-300 dark:hover:bg-red-950/40"
        >
          {isPending ? "Revoking…" : "Revoke"}
        </button>
      </form>
      {state?.error ? (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * Issue #382: a QR sized comfortably for a phone screen is often too small
 * to reliably scan once printed onto a small physical card/sticker — pixel
 * width, not just display size, is what actually affects scannability at a
 * given print size. `margin`/`errorCorrectionLevel` stay fixed at the
 * existing print-tuned values (see generateQrDataUrl.ts's comment); size
 * only changes the raw pixel width the QR is rendered at.
 */
const QR_SIZE_OPTIONS = {
  small: { label: "Small (digital / phone screen)", width: 200 },
  medium: { label: "Medium (default)", width: 400 },
  large: { label: "Large (printed card or sticker)", width: 800 },
} as const;
type QrSize = keyof typeof QR_SIZE_OPTIONS;

export function CapabilitySharePanel({
  activeCapabilities,
}: {
  activeCapabilities: ActiveCapability[];
}) {
  const [state, action, isPending] = useActionState(
    createEmergencyCapability,
    undefined,
  );
  const [qrDataUrl, setQrDataUrl] = useState<string>();
  const [qrSize, setQrSize] = useState<QrSize>("medium");

  useEffect(() => {
    if (!state?.capabilityUrl) return;
    let active = true;
    QRCode.toDataURL(state.capabilityUrl, {
      errorCorrectionLevel: "Q",
      margin: 4,
      width: QR_SIZE_OPTIONS[qrSize].width,
    })
      .then((url) => active && setQrDataUrl(url))
      .catch(() => active && setQrDataUrl(undefined));
    return () => {
      active = false;
    };
  }, [state?.capabilityUrl, qrSize]);

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

      {activeCapabilities.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Active shares
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {activeCapabilities.map((capability) => (
              <ActiveCapabilityRow key={capability.id} capability={capability} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">No active shares.</p>
      )}

      <form action={action}>
        <button
          type="submit"
          disabled={isPending}
          className="flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-semibold text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
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
          <div
            role="radiogroup"
            aria-label="QR code size"
            className="flex gap-2 text-xs"
          >
            {(Object.keys(QR_SIZE_OPTIONS) as QrSize[]).map((size) => (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={qrSize === size}
                onClick={() => setQrSize(size)}
                className={`rounded-full border px-3 py-1 transition-colors ${
                  qrSize === size
                    ? "border-zinc-950 bg-zinc-950 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-950"
                    : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                }`}
              >
                {QR_SIZE_OPTIONS[size].label}
              </button>
            ))}
          </div>
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
          <p className="max-w-full text-xs break-all text-zinc-400 dark:text-zinc-500">
            {state.capabilityUrl}
          </p>
          <div className="flex gap-3">
            <CopyLinkButton text={state.capabilityUrl} />
            {qrDataUrl ? (
              <a
                href={qrDataUrl}
                download={`lafiya-emergency-qr-${qrSize}.png`}
                className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Download QR
              </a>
            ) : null}
          </div>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Valid until {formatDate(state.expiresAt)}. Anyone with this QR can
            view only the fields you allow on your emergency card. Pick a
            larger size before printing onto a small card or sticker.
          </p>
        </div>
      ) : null}
    </section>
  );
}
