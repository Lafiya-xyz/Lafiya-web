'use client';

import React, { useState } from 'react';

interface SafeQrResultProps {
  payload: string;
  isLafiyaCard: boolean;
  onNavigate?: (url: string) => void;
  onReset?: () => void;
}

export function SafeQrResult({
  payload,
  isLafiyaCard,
  onNavigate,
  onReset,
}: SafeQrResultProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div
      role="dialog"
      aria-labelledby="qr-result-title"
      className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl flex flex-col gap-4 text-left"
    >
      <div className="flex items-center justify-between">
        <h3 id="qr-result-title" className="text-lg font-semibold text-white">
          {isLafiyaCard ? 'Emergency Card Detected' : 'Scanned QR Content'}
        </h3>
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-slate-400 hover:text-white text-sm"
          >
            Scan Again
          </button>
        )}
      </div>

      {!isLafiyaCard ? (
        <div className="flex flex-col gap-3">
          <div className="bg-amber-950/60 border border-amber-500/30 rounded-xl p-3 text-amber-200 text-xs flex items-start gap-2">
            <svg className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="font-medium text-amber-300">Non-Lafiya QR Content</p>
              <p className="mt-0.5 text-amber-200/80">
                This QR code does not originate from a verified Lafiya emergency card. Content is safely displayed as plain text and will never auto-open external URLs.
              </p>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-300 break-all select-all max-h-48 overflow-y-auto">
            {payload}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="w-full py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-medium transition-colors flex items-center justify-center gap-2"
          >
            {copied ? 'Copied to Clipboard' : 'Copy Plain Text'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="bg-emerald-950/50 border border-emerald-500/30 rounded-xl p-3 text-emerald-200 text-xs">
            Verified patient emergency card link.
          </div>
          <button
            type="button"
            onClick={() => onNavigate?.(payload)}
            className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-semibold transition-colors"
          >
            Open Emergency Card
          </button>
        </div>
      )}
    </div>
  );
}
