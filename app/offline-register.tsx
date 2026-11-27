"use client";

import { useCallback, useEffect, useState } from "react";

import {
  checkOfflineReadiness,
  clearReadinessMarker,
  type ReadinessReport,
} from "@/lib/offline/readiness";

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

/**
 * The service worker may only ever be registered from this fixed path. CSP
 * `worker-src` (see next.config.ts) additionally blocks registration from any
 * other path, so a compromised page cannot swap in an attacker-controlled
 * worker script.
 */
const SERVICE_WORKER_PATH = "/sw.js";

/**
 * Endpoint that returns the build-manifest hash the server expects the active
 * worker to report. Kept same-origin and unauthenticated; it exposes only a
 * build hash, never PHI or capability tokens.
 */
const WORKER_MANIFEST_ENDPOINT = "/api/sw-manifest";

/**
 * Privacy-safe mismatch report endpoint. Payloads contain only the expected
 * and reported hashes plus a coarse reason code — no PHI, phone numbers,
 * URLs, or user identifiers.
 */
const WORKER_MISMATCH_ENDPOINT = "/api/sw-mismatch";

type WorkerManifest = {
  /** Expected build-manifest hash of the worker. */
  hash: string;
  /** When true the server has asked clients to remove the worker + caches. */
  killSwitch?: boolean;
};

async function fetchWorkerManifest(): Promise<WorkerManifest | null> {
  try {
    const response = await fetch(WORKER_MANIFEST_ENDPOINT, {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Partial<WorkerManifest> | null;
    if (!data || typeof data.hash !== "string" || data.hash.length === 0) {
      return null;
    }
    return { hash: data.hash, killSwitch: data.killSwitch === true };
  } catch {
    // Manifest lookup is best-effort; never break the page over it.
    return null;
  }
}

function reportWorkerMismatch(expected: string, reported: string | null, reason: string) {
  // Fire-and-forget, privacy-safe: only hashes and a reason code leave the
  // device. Failures are swallowed so reporting never affects the page.
  try {
    void fetch(WORKER_MISMATCH_ENDPOINT, {
      method: "POST",
      credentials: "omit",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected, reported, reason }),
    }).catch(() => {});
  } catch {
    // Ignore.
  }
}

/**
 * Asks the active worker for the hash it was built from. The worker answers
 * over a MessageChannel so we never rely on a shared global.
 */
function queryWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === "undefined") {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 3000);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      channel.port1.close();
      const data = event.data as { type?: string; hash?: unknown } | null;
      if (data && data.type === "SW_VERSION" && typeof data.hash === "string") {
        resolve(data.hash);
      } else {
        resolve(null);
      }
    };
    try {
      worker.postMessage({ type: "SW_VERSION_REQUEST" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      channel.port1.close();
      resolve(null);
    }
  });
}

/**
 * Server-controlled kill switch: tell the worker to stop controlling pages,
 * unregister it, and clear every cache it may have populated. Used when the
 * server reports `killSwitch: true` (for example after a bad deploy).
 */
async function runKillSwitch(registration: ServiceWorkerRegistration) {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (worker) {
    try {
      worker.postMessage({ type: "SW_KILL_SWITCH" });
    } catch {
      // Ignore; unregistering below is the authoritative step.
    }
  }

  try {
    await registration.unregister();
  } catch {
    // Ignore.
  }

  if (typeof caches !== "undefined") {
    try {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    } catch {
      // Cache clearing is best-effort.
    }
  }
}

async function verifyActiveWorker(registration: ServiceWorkerRegistration) {
  const manifest = await fetchWorkerManifest();
  if (!manifest) return;

  if (manifest.killSwitch) {
    await runKillSwitch(registration);
    return;
  }

  const active = registration.active;
  if (!active) return;

  const reported = await queryWorkerVersion(active);
  if (reported === null) {
    reportWorkerMismatch(manifest.hash, null, "no-version");
    return;
  }
  if (reported !== manifest.hash) {
    reportWorkerMismatch(manifest.hash, reported, "hash-mismatch");
  }
}

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
        .register(SERVICE_WORKER_PATH, { type: "module" })
        .then((registration) => {
          // Only schedule periodic refresh once the worker is active so the
          // sync event has a handler to receive it.
          if (registration.active) {
            void registerPeriodicSync(registration);
            void verifyActiveWorker(registration);
            return;
          }

          const worker = registration.installing ?? registration.waiting;
          if (!worker) return;

          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") {
              void registerPeriodicSync(registration);
              void verifyActiveWorker(registration);
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
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);

  const refresh = useCallback(async () => {
    // Issue #875: verify the cached envelope is actually still on this device.
    checkOfflineReadiness().then(setReadiness, () => setReadiness(null));
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
      {readiness && (
        <ReadinessDetails
          report={readiness}
          onDismiss={() => {
            clearReadinessMarker();
            void refresh();
          }}
        />
      )}
    </div>
  );
}

const READINESS_LABEL: Record<ReadinessReport["state"], string> = {
  ready: "Offline copy saved on this device",
  stale: "Offline copy is out of date — open your card while online to refresh it",
  evicted: "Your offline copy was removed by this browser",
  missing: "No offline copy saved on this device yet — open your card once while online",
  unsupported: "This browser can't keep an offline copy",
};

function ReadinessDetails({
  report,
  onDismiss,
}: {
  report: ReadinessReport;
  onDismiss: () => void;
}) {
  const atRisk = report.state !== "ready" || report.platform === "ios-tab";
  return (
    <div className="mt-2" data-readiness={report.state} data-platform={report.platform}>
      <p role={report.state === "evicted" ? "alert" : undefined}>
        Offline readiness: {READINESS_LABEL[report.state]}
      </p>
      {atRisk && report.platform === "ios-tab" && (
        <p className="text-muted-foreground mt-1">
          Safari deletes saved site data after 7 days without a visit. Add Lafiya
          to your Home Screen (Share → Add to Home Screen) to keep it, and keep a
          printed card, wallet pass or lock-screen wallpaper as a backup.
        </p>
      )}
      {atRisk && report.platform !== "ios-tab" && (
        <p className="text-muted-foreground mt-1">
          Keep a printed card, wallet pass or lock-screen wallpaper as a backup
          in case this browser clears its storage.
        </p>
      )}
      {report.state === "evicted" && (
        <button
          type="button"
          className="mt-2 rounded border px-2 py-1"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
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
