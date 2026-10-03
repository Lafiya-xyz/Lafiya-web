"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Registers the offline service worker (public/sw.js) once the app has
 * loaded. It is registered for the whole origin so that by the time a
 * responder opens a /card/* page the worker is already active and able to
 * cache it.
 *
 * Registration is skipped in development to avoid caching the hot-reload dev
 * server's responses, which would make offline behaviour confusing to test.
 * Offline support is treated as a progressive enhancement: a registration
 * failure is swallowed and never breaks the page.
 *
 * Once the worker is active we also register a Periodic Background Sync task
 * (tag "lafiya-refresh", 12h minimum interval) so cached emergency envelopes
 * can be refreshed while the device is online without the user reopening the
 * card. Periodic sync is only available on installed Chromium PWAs, so it is
 * registered best-effort and silently skipped where unsupported.
 */

const PERIODIC_SYNC_TAG = "lafiya-refresh";
const PERIODIC_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function registerPeriodicSync(registration: ServiceWorkerRegistration) {
  // Periodic Background Sync is a progressive enhancement: only Chromium
  // installed PWAs expose it, and it requires the user to have granted the
  // periodic-background-sync permission. Never let a failure surface.
  const periodicSync = (
    registration as ServiceWorkerRegistration & {
      periodicSync?: {
        register: (tag: string, options: { minInterval: number }) => Promise<void>;
      };
    }
  ).periodicSync;

  if (!periodicSync || typeof periodicSync.register !== "function") return;

  try {
    await periodicSync.register(PERIODIC_SYNC_TAG, {
      minInterval: PERIODIC_SYNC_MIN_INTERVAL_MS,
    });
  } catch {
    // Permission denied or unsupported: refresh stays user-driven.
  }
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    if (process.env.NODE_ENV === "development") return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { type: "module" })
        .then((registration) => {
          // Only schedule periodic refresh once the worker is active so the
          // sync event has a handler to receive it.
          if (registration.active) {
            void registerPeriodicSync(registration);
            return;
          }

          const worker = registration.installing ?? registration.waiting;
          if (!worker) return;

          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") {
              void registerPeriodicSync(registration);
            }
          });
        })
        .catch(() => {
          // Offline caching is best-effort; ignore registration errors.
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}

type PersistenceState = "unknown" | "protected" | "best-effort" | "unsupported";

/**
 * Reports whether the emergency card cache is protected from storage
 * eviction. Browsers may evict "best-effort" storage under pressure, which is
 * common on low-storage phones, so an evicted emergency envelope would be a
 * silent failure.
 *
 * Persistence is only requested after an explicit user gesture (the button
 * below), never automatically on load. Chrome grants persistence
 * heuristically (for example, to installed PWAs), so the copy explains the
 * benefit of installing. No PHI or capability tokens are read or sent here.
 */
export function OfflineStorageStatus() {
  const [state, setState] = useState<PersistenceState>("unknown");
  const [usage, setUsage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  const refresh = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.storage) {
      setState("unsupported");
      return;
    }
    if (typeof navigator.storage.persisted === "function") {
      try {
        setState((await navigator.storage.persisted()) ? "protected" : "best-effort");
      } catch {
        setState("best-effort");
      }
    } else {
      setState("best-effort");
    }

    if (typeof navigator.storage.estimate === "function") {
      try {
        const { usage: used, quota } = await navigator.storage.estimate();
        if (typeof used === "number" && typeof quota === "number" && quota > 0) {
          setUsage(`${formatBytes(used)} of ${formatBytes(quota)} used`);
        }
      } catch {
        // Usage reporting is debug-safe and best-effort; ignore errors.
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestPersistence = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.storage) return;
    if (typeof navigator.storage.persist !== "function") return;
    setRequesting(true);
    try {
      await navigator.storage.persist();
    } catch {
      // Persistence is best-effort; the status below reflects the result.
    } finally {
      setRequesting(false);
      void refresh();
    }
  }, [refresh]);

  const canRequest =
    state === "best-effort" &&
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.persist === "function";

  return (
    <div className="rounded-md border p-3 text-sm">
      <p>
        Offline card:{" "}
        {state === "protected"
          ? "protected"
          : state === "unsupported"
            ? "not supported by this browser"
            : "may be cleared"}
      </p>
      {state === "best-effort" && (
        <p className="text-muted-foreground mt-1">
          Installing the app or protecting storage helps keep the emergency card
          available offline.
        </p>
      )}
      {canRequest && (
        <button
          type="button"
          className="mt-2 rounded border px-2 py-1"
          onClick={requestPersistence}
          disabled={requesting}
        >
          {requesting ? "Protecting…" : "Protect offline card"}
        </button>
      )}
      {usage && <p className="text-muted-foreground mt-1">{usage}</p>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
