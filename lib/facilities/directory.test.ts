import { describe, expect, it } from "vitest";

import {
  SHARD_BUDGET_BYTES,
  buildShards,
  shardSizes,
} from "../../scripts/build-facility-directory.mjs";
import { distanceKm, rankFacilities, type Facility } from "./directory";

const base = {
  type: "hospital",
  lga: null,
  emergency24h: false,
  phone: null,
} as const;
const facilities: Facility[] = [
  { ...base, id: "a", name: "Alpha", lat: 6.5, lon: 3.4 },
  { ...base, id: "b", name: "Beta", lat: 9.07, lon: 7.49, emergency24h: true },
];

const input = {
  source: {
    name: "fixture",
    url: null,
    license: "ODbL-1.0",
    retrieved: "2026-10-01",
  },
  facilities: [
    {
      id: "2",
      name: "Zed",
      state: "Lagos",
      lat: 6.6,
      lon: 3.3,
      type: "clinic",
    },
    {
      id: "1",
      name: "Ace",
      state: "Lagos",
      lat: 6.5,
      lon: 3.4,
      type: "hospital",
      emergency24h: true,
    },
    { id: "3", name: "Bad", state: "Lagos", lat: "x", lon: 3 },
    { id: "4", name: "Fct", state: "FCT Abuja", lat: 9, lon: 7.4 },
  ],
};

describe("facility directory", () => {
  it("computes straight-line distance", () => {
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(
      111.19,
      1,
    );
  });

  it("sorts by distance when location is available", () => {
    const ranked = rankFacilities(facilities, { lat: 9, lon: 7.5 });
    expect(ranked.map((f) => f.id)).toEqual(["b", "a"]);
    expect(ranked[0]?.distanceKm).toBeGreaterThan(0);
  });

  it("falls back to region order without location", () => {
    const ranked = rankFacilities(facilities, null);
    expect(ranked.map((f) => f.id)).toEqual(["b", "a"]);
    expect(ranked[0]?.distanceKm).toBeNull();
  });

  it("builds reproducible, sharded output with provenance", () => {
    const first = buildShards(input);
    const second = buildShards(structuredClone(input));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.keys(first.shards)).toEqual(["fct-abuja", "lagos"]);
    expect(
      (
        first.shards as Record<string, { facilities: Facility[] }>
      ).lagos!.facilities.map((f: Facility) => f.id),
    ).toEqual(["1", "2"]);
    expect(first.index.source.license).toBe("ODbL-1.0");
  });

  it("keeps shards within the size budget", () => {
    const sizes = shardSizes(buildShards(input).shards) as Record<
      string,
      number
    >;
    for (const size of Object.values(sizes)) {
      expect(size).toBeLessThanOrEqual(SHARD_BUDGET_BYTES);
    }
  });
});
