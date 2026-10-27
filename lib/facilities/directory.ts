/**
 * Issue #763: offline nearest-facility directory for responders.
 *
 * Shards are built by scripts/build-facility-directory.mjs and served from
 * /facilities/<state>.json. The service worker caches a shard after first
 * use so the list keeps working with no signal. Location is only ever used
 * on-device to sort the list; it is never sent over the network.
 */

export type Facility = {
  id: string;
  name: string;
  type: "hospital" | "clinic" | "phc" | "other";
  lga: string | null;
  lat: number;
  lon: number;
  emergency24h: boolean;
  phone: string | null;
};

export type FacilityShard = {
  version: string;
  state: string;
  source: {
    name: string;
    url: string | null;
    license: string;
    retrieved: string;
  };
  facilities: Facility[];
};

export type Coordinates = { lat: number; lon: number };

export const FACILITY_SHARD_PATH = "/facilities/";

const EARTH_RADIUS_KM = 6371;

/** Great-circle (straight-line) distance in kilometres. */
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export type RankedFacility = Facility & { distanceKm: number | null };

/**
 * Sorts by straight-line distance when a location is available; otherwise
 * keeps the region list order (24h emergency facilities first, then name).
 */
export function rankFacilities(
  facilities: readonly Facility[],
  origin: Coordinates | null,
): RankedFacility[] {
  if (origin === null) {
    return [...facilities]
      .sort(
        (a, b) =>
          Number(b.emergency24h) - Number(a.emergency24h) ||
          a.name.localeCompare(b.name),
      )
      .map((f) => ({ ...f, distanceKm: null }));
  }
  return facilities
    .map((f) => ({ ...f, distanceKm: distanceKm(origin, f) }))
    .sort(
      (a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name),
    );
}

export function shardUrl(state: string): string {
  return `${FACILITY_SHARD_PATH}${encodeURIComponent(state)}.json`;
}

export async function loadShard(
  state: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FacilityShard | null> {
  try {
    const response = await fetchImpl(shardUrl(state));
    if (!response.ok) return null;
    return (await response.json()) as FacilityShard;
  } catch {
    return null;
  }
}
