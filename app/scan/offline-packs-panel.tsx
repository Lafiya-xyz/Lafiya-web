"use client";

import { useEffect, useState } from "react";

import {
  activePackVersion,
  prefersSaveData,
  startPackDownload,
  type PackManifest,
  type PackProgress,
} from "@/lib/offline/packs";

const PACK_INDEX_URL = "/packs/index.json";

function parsePublicKey(): JsonWebKey | null {
  try {
    const raw = process.env.NEXT_PUBLIC_OFFLINE_PACK_PUBLIC_KEY;
    return raw ? (JSON.parse(raw) as JsonWebKey) : null;
  } catch {
    return null;
  }
}

// NEXT_PUBLIC_* values are inlined at build time.
const PACK_PUBLIC_KEY = parsePublicKey();

const formatMb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/**
 * Issue #876: download large offline packs (facility directory, fonts,
 * translations). Never starts automatically; with Save-Data on, the
 * responder must confirm explicitly.
 */
export function OfflinePacksPanel() {
  const [packs, setPacks] = useState<PackManifest[]>([]);
  const [active, setActive] = useState<Record<string, string | null>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<string | null>(null);
  const [saveData, setSaveData] = useState(false);
  const key = PACK_PUBLIC_KEY;

  useEffect(() => {
    if (!key || typeof caches === "undefined") return;
    setSaveData(prefersSaveData());
    void (async () => {
      const response = await fetch(PACK_INDEX_URL).catch(() => null);
      const list = (
        response?.ok ? await response.json().catch(() => []) : []
      ) as PackManifest[];
      setPacks(list);
      const versions: Record<string, string | null> = {};
      for (const p of list) versions[p.name] = await activePackVersion(p.name);
      setActive(versions);
      const estimate = await navigator.storage?.estimate?.().catch(() => null);
      if (estimate?.usage !== undefined) setUsage(formatMb(estimate.usage));
    })();
  }, [key]);

  if (!key || packs.length === 0) return null;

  const download = async (pack: PackManifest) => {
    const onProgress = ({ done, total }: PackProgress) =>
      setProgress((p) => ({ ...p, [pack.name]: `${done}/${total} chunks` }));
    setProgress((p) => ({ ...p, [pack.name]: "Starting…" }));
    const result = await startPackDownload(pack, key, onProgress);
    setProgress((p) => ({
      ...p,
      [pack.name]:
        result === "background"
          ? "Downloading in the background (you can close this tab)"
          : result === "complete"
            ? "Ready offline"
            : "Download failed — try again to resume",
    }));
    if (result === "complete") {
      setActive((a) => ({ ...a, [pack.name]: pack.version }));
    }
  };

  return (
    <section
      aria-labelledby="offline-packs-heading"
      className="mx-auto max-w-xl space-y-2 p-4 text-sm text-zinc-100"
    >
      <h2 id="offline-packs-heading" className="text-base font-semibold">
        Offline packs
      </h2>
      {saveData && (
        <p>Data Saver is on. Packs download only when you choose to.</p>
      )}
      <ul className="space-y-2">
        {packs.map((pack) => (
          <li
            key={pack.name}
            className="flex items-center justify-between gap-2"
          >
            <span>
              {pack.name} ({formatMb(pack.size)})
              {active[pack.name] === pack.version ? " — ready offline" : ""}
              {progress[pack.name] ? ` — ${progress[pack.name]}` : ""}
            </span>
            {active[pack.name] !== pack.version && (
              <button
                type="button"
                className="rounded border px-3 py-1"
                onClick={() => void download(pack)}
              >
                {saveData ? "Download anyway" : "Download"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {usage && <p>Storage used on this device: {usage}</p>}
    </section>
  );
}
