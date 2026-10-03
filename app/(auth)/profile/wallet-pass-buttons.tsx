"use client";

import { useState } from "react";

/**
 * Issue #538: "Add to Wallet" buttons for the current emergency capability
 * QR. Calls POST /api/wallet/apple (downloads a signed .pkpass) and POST
 * /api/wallet/google (returns a save link to open). Neither platform is
 * functional yet on any deployment — no signing credentials exist — so
 * both routes currently respond 501, and these buttons surface that error
 * message rather than pretending to succeed. See docs/wallet-passes.md.
 */
export function WalletPassButtons({ capabilityUrl }: { capabilityUrl: string }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<"apple" | "google">();

  async function handleApple() {
    setError(undefined);
    setPending("apple");
    try {
      const response = await fetch("/api/wallet/apple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilityUrl }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error ?? "Could not add this card to Apple Wallet.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "lafiya-emergency-card.pkpass";
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not add this card to Apple Wallet.");
    } finally {
      setPending(undefined);
    }
  }

  async function handleGoogle() {
    setError(undefined);
    setPending("google");
    try {
      const response = await fetch("/api/wallet/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilityUrl }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error ?? "Could not add this card to Google Wallet.");
        return;
      }
      if (payload?.saveUrl) {
        window.open(payload.saveUrl, "_blank", "noopener,noreferrer");
      }
    } catch {
      setError("Could not add this card to Google Wallet.");
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={handleApple}
          disabled={pending !== undefined}
          className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          {pending === "apple" ? "Adding…" : "Add to Apple Wallet"}
        </button>
        <button
          type="button"
          onClick={handleGoogle}
          disabled={pending !== undefined}
          className="min-h-11 rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-900"
        >
          {pending === "google" ? "Adding…" : "Add to Google Wallet"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="max-w-xs text-center text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
