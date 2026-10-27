"use client";

import { useEffect, useState } from "react";

import {
  FACILITY_SHARD_PATH,
  loadShard,
  rankFacilities,
  type Coordinates,
  type FacilityShard,
} from "@/lib/facilities/directory";

/**
 * Issue #763: nearest-facility directory for responders. The state shard is
 * cached by the service worker after first use so it keeps working offline.
 * Location stays on this device: it is only used to sort the list locally.
 */
const STATE_STORAGE_KEY = "lafiya-facility-state";

function readStoredState(): string {
  try {
    return localStorage.getItem(STATE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function FacilityDirectory() {
  const [states, setStates] = useState<string[]>([]);
  const [state, setState] = useState("");
  const [shard, setShard] = useState<FacilityShard | null | undefined>(
    undefined,
  );
  const [origin, setOrigin] = useState<Coordinates | null>(null);

  useEffect(() => {
    setState(readStoredState());
    fetch(`${FACILITY_SHARD_PATH}index.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((index: { states: { state: string }[] } | null) =>
        setStates(index?.states.map((s) => s.state) ?? []),
      )
      .catch(() => setStates([]));
  }, []);

  useEffect(() => {
    if (!state) return;
    let active = true;
    try {
      localStorage.setItem(STATE_STORAGE_KEY, state);
    } catch {
      // Storage unavailable; the region simply is not remembered.
    }
    void loadShard(state).then((result) => {
      if (active) setShard(result);
    });
    return () => {
      active = false;
    };
  }, [state]);

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (position) =>
        setOrigin({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        }),
      () => setOrigin(null),
      { maximumAge: 300_000, timeout: 10_000 },
    );
  }

  if (states.length === 0 && !state) return null;

  return (
    <section
      aria-labelledby="facility-directory-heading"
      data-testid="facility-directory"
      className="rounded-lg border border-zinc-300 p-4 text-sm dark:border-zinc-700"
    >
      <h2 id="facility-directory-heading" className="text-lg font-semibold">
        Nearby health facilities
      </h2>
      <label className="mt-2 flex flex-col gap-1">
        Region
        <select
          value={state}
          onChange={(event) => setState(event.target.value)}
          className="rounded border px-2 py-1"
        >
          <option value="">Choose a state</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {shard === undefined ? null : shard === null ? (
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          Facility list unavailable for this region.
        </p>
      ) : (
        <>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">
            Data from {shard.source.name} ({shard.source.license}), retrieved{" "}
            {shard.source.retrieved}. Details may be out of date: verify by
            phone before transporting a patient.
          </p>
          {origin === null ? (
            <button
              type="button"
              onClick={useMyLocation}
              className="mt-2 rounded-full border border-zinc-950 px-3 py-1 text-xs dark:border-zinc-50"
            >
              Sort by distance (location stays on this device)
            </button>
          ) : null}
          <ul className="mt-3 flex flex-col gap-2">
            {rankFacilities(shard.facilities, origin)
              .slice(0, 10)
              .map((facility) => (
                <li key={facility.id}>
                  <span className="font-medium">{facility.name}</span>
                  {facility.emergency24h ? " · 24h emergency" : ""}
                  {facility.distanceKm !== null
                    ? ` · ${facility.distanceKm.toFixed(1)} km`
                    : facility.lga
                      ? ` · ${facility.lga}`
                      : ""}
                  {facility.phone ? (
                    <>
                      {" · "}
                      <a href={`tel:${facility.phone}`} className="underline">
                        {facility.phone}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}
