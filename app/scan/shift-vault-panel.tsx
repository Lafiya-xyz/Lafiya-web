"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { renderOfflineEnvelope } from "@/public/offline-cache-helpers.js";
import {
  SHIFT_MAX_CARDS,
  SHIFT_MAX_MS,
  endShift,
  flushVaultAudit,
  getShift,
  isShiftActive,
  listVault,
  openVaultEntry,
  openVaultStore,
  startShift,
  wipeIfExpired,
} from "@/public/shift-vault.js";

type Shift = { startedAt: number; endsAt: number; credentialId: string | null };
type VaultItem = { id: string; scannedAt: number };

const toBase64Url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );

async function platformVerifierAvailable(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== "undefined" &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

/** Shift-scoped device-unlock credential; only its id is kept, in the vault. */
async function createShiftCredential(): Promise<string | null> {
  if (!(await platformVerifierAvailable())) return null;
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Lafiya responder shift" },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: "responder-shift",
          displayName: "Responder shift",
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
        },
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
    return credential ? toBase64Url(credential.rawId) : null;
  } catch {
    return null;
  }
}

async function verifyDeviceUnlock(
  credentialId: string | null,
): Promise<boolean> {
  if (!credentialId) return true; // Not available on this device.
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [
          { type: "public-key", id: fromBase64Url(credentialId) },
        ],
        userVerification: "required",
        timeout: 60_000,
      },
    });
    return assertion !== null;
  } catch {
    return false;
  }
}

/**
 * Issue #873: opt-in responder shift vault on /scan. Cards opened during a
 * shift (with patient offline consent) stay available offline until the
 * shift ends, then the vault key is destroyed.
 */
export function ShiftVaultPanel() {
  const store = useMemo(
    () => (typeof indexedDB === "undefined" ? null : openVaultStore()),
    [],
  );
  const [shift, setShift] = useState<Shift | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [hours, setHours] = useState(12);
  const [openHtml, setOpenHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!store) return;
    await wipeIfExpired(store);
    const current = (await getShift(store)) as Shift | null;
    setShift(isShiftActive(current) ? current : null);
    setItems(await listVault(store));
    void flushVaultAudit(store);
  }, [store]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refresh);
    };
  }, [refresh]);

  if (!store) return null;

  const onStart = async () => {
    setError(null);
    const credentialId = await createShiftCredential();
    await startShift(store, {
      durationMs: Math.min(hours * 3_600_000, SHIFT_MAX_MS),
      credentialId,
    });
    await refresh();
  };

  const onEnd = async () => {
    await endShift(store);
    setOpenHtml(null);
    await refresh();
  };

  const onOpen = async (id: string) => {
    setError(null);
    if (!(await verifyDeviceUnlock(shift?.credentialId ?? null))) {
      setError("Device unlock is required to reopen vaulted cards.");
      return;
    }
    const entry = await openVaultEntry(store, id);
    if (!entry) {
      setError("This card is no longer available.");
      return refresh();
    }
    setOpenHtml(renderOfflineEnvelope(entry.envelope));
  };

  return (
    <section
      aria-labelledby="shift-vault-heading"
      className="mx-auto max-w-xl space-y-3 p-4 text-sm text-zinc-100"
    >
      <h2 id="shift-vault-heading" className="text-base font-semibold">
        Responder shift vault
      </h2>
      {shift ? (
        <>
          <p>
            Shift active until {new Date(shift.endsAt).toLocaleTimeString()}.{" "}
            {items.length}/{SHIFT_MAX_CARDS} cards kept offline. Cards are wiped
            automatically when the shift ends.
          </p>
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="underline"
                  onClick={() => void onOpen(item.id)}
                >
                  Card scanned {new Date(item.scannedAt).toLocaleTimeString()}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="rounded border px-3 py-1"
            onClick={() => void onEnd()}
          >
            End shift and wipe vault
          </button>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <label htmlFor="shift-hours">Shift length (hours)</label>
          <input
            id="shift-hours"
            type="number"
            min={1}
            max={12}
            value={hours}
            onChange={(e) =>
              setHours(Math.max(1, Math.min(12, Number(e.target.value) || 1)))
            }
            className="w-16 rounded bg-zinc-800 px-2 py-1"
          />
          <button
            type="button"
            className="rounded border px-3 py-1"
            onClick={() => void onStart()}
          >
            Start shift
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {openHtml && (
        <iframe
          title="Vaulted emergency card"
          sandbox=""
          srcDoc={openHtml}
          className="h-96 w-full rounded bg-white"
        />
      )}
    </section>
  );
}
