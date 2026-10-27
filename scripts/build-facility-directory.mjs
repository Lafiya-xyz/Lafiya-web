#!/usr/bin/env node
/**
 * scripts/build-facility-directory.mjs
 *
 * Issue #763: builds the offline nearest-facility directory from an openly
 * licensed facility registry export (e.g. healthsites.io, ODbL 1.0).
 *
 * Input (normalised JSON):
 *   {
 *     "source": { "name", "url", "license", "retrieved" },
 *     "facilities": [{ "id", "name", "type", "state", "lga",
 *                      "lat", "lon", "emergency24h", "phone" }]
 *   }
 *
 * Output: one shard per state at <out>/<state-slug>.json plus index.json.
 * The build is reproducible: no wall-clock timestamps, stable sort order and
 * the dataset version is a content hash of the input.
 *
 * Usage:
 *   node scripts/build-facility-directory.mjs <input.json> [outDir] [--check]
 *
 * --check fails (exit 1) when any shard exceeds SHARD_BUDGET_BYTES, so CI can
 * enforce the per-shard size budget.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SHARD_BUDGET_BYTES = 150 * 1024;
export const FACILITY_TYPES = ["hospital", "clinic", "phc", "other"];

export function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function round(value) {
  return Math.round(Number(value) * 1e5) / 1e5;
}

function normaliseFacility(raw) {
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!raw.id || !raw.name || !raw.state) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const type = FACILITY_TYPES.includes(raw.type) ? raw.type : "other";
  return {
    id: String(raw.id),
    name: String(raw.name).trim(),
    type,
    lga: raw.lga ? String(raw.lga).trim() : null,
    lat: round(lat),
    lon: round(lon),
    emergency24h: raw.emergency24h === true,
    phone: raw.phone ? String(raw.phone).trim() : null,
  };
}

export function buildShards(input) {
  const { source, facilities } = input;
  if (!source?.name || !source?.license || !source?.retrieved) {
    throw new Error(
      "source.name, source.license and source.retrieved are required",
    );
  }
  const version = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 12);

  const byState = new Map();
  for (const raw of facilities ?? []) {
    const facility = normaliseFacility(raw);
    if (!facility) continue;
    const state = slugify(raw.state);
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state).push(facility);
  }

  const provenance = {
    name: source.name,
    url: source.url ?? null,
    license: source.license,
    retrieved: source.retrieved,
  };

  const shards = {};
  for (const state of [...byState.keys()].sort()) {
    const list = byState
      .get(state)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    shards[state] = { version, state, source: provenance, facilities: list };
  }
  const index = {
    version,
    source: provenance,
    states: Object.keys(shards).map((state) => ({
      state,
      count: shards[state].facilities.length,
    })),
  };
  return { index, shards };
}

export function shardSizes(shards) {
  return Object.fromEntries(
    Object.entries(shards).map(([state, shard]) => [
      state,
      Buffer.byteLength(JSON.stringify(shard)),
    ]),
  );
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const check = argv.includes("--check");
  const [inputPath, outDir = "public/facilities"] = args;
  if (!inputPath) {
    console.error(
      "usage: build-facility-directory.mjs <input.json> [outDir] [--check]",
    );
    process.exit(2);
  }
  const { index, shards } = buildShards(
    JSON.parse(readFileSync(inputPath, "utf8")),
  );
  const sizes = shardSizes(shards);
  const over = Object.entries(sizes).filter(
    ([, size]) => size > SHARD_BUDGET_BYTES,
  );
  for (const [state, size] of over) {
    console.error(
      `shard ${state} is ${size} bytes (budget ${SHARD_BUDGET_BYTES})`,
    );
  }
  if (check) process.exit(over.length > 0 ? 1 : 0);
  if (over.length > 0) process.exit(1);

  mkdirSync(outDir, { recursive: true });
  for (const [state, shard] of Object.entries(shards)) {
    writeFileSync(join(outDir, `${state}.json`), JSON.stringify(shard));
  }
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index));
  console.log(
    `wrote ${Object.keys(shards).length} shard(s), version ${index.version}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
