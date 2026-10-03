"use client";

import { useEffect, useRef, useState } from "react";

import { logNfcCardWrite } from "./actions";

// Web NFC (NDEFReader) is a Chrome-on-Android-only API with no shipped
// TypeScript lib types. This is the minimal surface this component needs,
// scoped locally rather than added as a global declaration.
interface NdefWriteOptions {
  records: Array<{ recordType: "url"; data: string }>;
}
interface NdefReaderLike {
  write(message: NdefWriteOptions): Promise<void>;
}
interface NdefReaderConstructor {
  new (): NdefReaderLike;
}

type WriteStatus = "idle" | "writing" | "success" | "error";

function isWebNfcSupported(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

function getNfcErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "NFC permission was denied. Allow NFC access for this site in Chrome and try again.";
    }
    if (error.name === "NotSupportedError") {
      return "This device does not support writing NFC tags.";
    }
    if (error.name === "NotReadableError" || error.name === "NetworkError") {
      return "Could not write to the tag. Hold a blank NTAG213/215 tag steady against the back of your phone and try again.";
    }
  }
  return "Could not write the card link to the tag. Please try again.";
}

/**
 * Issue #537: writes the card's capability URL to an NFC tag as a
 * tap-to-open alternative to the QR code. Web NFC is only available in
 * Chrome on Android (`NDEFReader in window`), so unsupported browsers get a
 * graceful, always-visible explanation instead of the write control.
 */
export function NfcWriteButton({
  cardUrl,
  revokeHref,
}: {
  cardUrl: string;
  revokeHref: string;
}) {
  // Web NFC support can only be known on the client. Start `false` so the
  // server-rendered markup and the first client render match (avoiding a
  // hydration mismatch), then flip to the real capability once mounted.
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<WriteStatus>("idle");
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setSupported(isWebNfcSupported());
  }, []);

  if (!supported) {
    return (
      <p className="max-w-xs text-xs text-zinc-500 dark:text-zinc-500">
        Writing to an NFC tag needs Chrome on an Android phone. On this
        device, share the QR code or link above instead.
      </p>
    );
  }

  async function handleWrite() {
    setStatus("writing");
    setError(undefined);
    try {
      const NDEFReader = (
        window as unknown as { NDEFReader: NdefReaderConstructor }
      ).NDEFReader;
      const reader = new NDEFReader();
      await reader.write({ records: [{ recordType: "url", data: cardUrl }] });
      setStatus("success");
      void logNfcCardWrite("success");
    } catch (err) {
      setStatus("error");
      setError(getNfcErrorMessage(err));
      void logNfcCardWrite("error");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setStatus("idle");
          setError(undefined);
          dialogRef.current?.showModal();
        }}
        className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900 dark:focus:ring-zinc-600"
      >
        Write to NFC tag
      </button>

      <dialog
        ref={dialogRef}
        className="w-full max-w-sm rounded-xl border border-zinc-300 bg-white p-6 text-zinc-950 backdrop:bg-black/40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      >
        <h2 className="text-lg font-semibold">Write card link to NFC tag?</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Anyone who taps a phone against this tag will get the same access as
          scanning the QR code above — no login required. Only write this to
          a tag you control, such as a wristband or medical ID card. You can{" "}
          <a href={revokeHref} className="underline">
            revoke access
          </a>{" "}
          at any time if the tag is lost or the link needs to change.
        </p>

        {status === "success" ? (
          <p role="status" className="mt-3 text-sm text-green-700 dark:text-green-400">
            Written! Tap the tag with your phone to test it.
          </p>
        ) : null}
        {status === "error" && error ? (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        {status === "writing" ? (
          <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
            Hold a blank NTAG213/215 tag against the back of your phone…
          </p>
        ) : null}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus:ring-zinc-600"
          >
            {status === "success" ? "Done" : "Cancel"}
          </button>
          {status !== "success" ? (
            <button
              type="button"
              onClick={handleWrite}
              disabled={status === "writing"}
              className="min-h-11 rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-0 focus:outline-none dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200 dark:focus:ring-zinc-600"
            >
              {status === "writing" ? "Writing…" : "Write tag"}
            </button>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
