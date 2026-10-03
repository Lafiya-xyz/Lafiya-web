'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

import { CopyLinkButton } from "./copy-link-button";
import { NfcWriteButton } from "./nfc-write-button";
import { RegenerateCardButton } from "./regenerate-card-button";

    let cancelled = false;

    QRCode.toCanvas(
      canvas,
      value,
      {
        width: size,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      },
      (err) => {
        if (cancelled) return;
        setError(err ? 'Unable to render QR code.' : null);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-2">
      <div
        className="w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-neutral-300 bg-white p-3 forced-colors:border-[CanvasText]"
        style={{ forcedColorAdjust: 'none' }}
      >
        {cardUrl}
      </p>
      <div className="flex flex-col items-center gap-1">
        <p className="max-w-xs text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Test your QR code
        </p>
        <p className="max-w-xs text-xs text-zinc-500 dark:text-zinc-500">
          Point your phone&apos;s camera at the QR code above, or open the link
          below on another device to confirm it works before relying on it in an
          emergency.
        </p>
        <a
          href={cardUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-zinc-700 underline dark:text-zinc-300"
        >
          Open card link
        </a>
      </div>
      <p className="max-w-xs text-xs text-amber-700 dark:text-amber-300">
        This legacy QR will stop working on {formatDate(legacySunsetAt)}.
        Create a current emergency QR below.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <CopyLinkButton text={cardUrl} />
        <NfcWriteButton cardUrl={cardUrl} revokeHref="#capability-share-heading" />
        <RegenerateCardButton />
      </div>
      {error ? (
        <p
          role="alert"
          className="max-w-full break-words text-sm text-red-600 forced-colors:text-[CanvasText]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
