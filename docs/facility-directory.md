# Nearest-facility directory (#763)

Offline-cacheable list of health facilities shown on the responder card.

## Data source and license

Build input is a normalised export of an openly licensed facility registry,
e.g. [healthsites.io](https://healthsites.io) (ODbL 1.0) or the Nigeria Health
Facility Registry where its terms permit redistribution. Each shard embeds the
source name, URL, license and retrieval date, which the UI displays alongside a
"verify by phone" caveat.

## Build

```bash
npm run facilities:build -- data/facilities.json public/facilities
npm run facilities:check -- data/facilities.json   # CI size budget
```

Input format:

```json
{
  "source": {
    "name": "healthsites.io",
    "url": "https://healthsites.io",
    "license": "ODbL-1.0",
    "retrieved": "2026-10-01"
  },
  "facilities": [
    {
      "id": "hs-1",
      "name": "…",
      "type": "hospital",
      "state": "Lagos",
      "lga": "Ikeja",
      "lat": 6.6,
      "lon": 3.35,
      "emergency24h": true,
      "phone": "+234…"
    }
  ]
}
```

- Output is one shard per state (`public/facilities/<state>.json`) plus
  `index.json`.
- Reproducible: stable sort, coordinates rounded to 5 dp, no timestamps; the
  dataset `version` is a content hash of the input.
- Each shard must be ≤ 150 KiB (`SHARD_BUDGET_BYTES`); the build and
  `--check` fail otherwise.

## Offline behaviour

`public/sw.js` serves `/facilities/*.json` network-first and stores each shard
in the `lafiya-facilities-v1` cache on first use, so the selected region keeps
working with no signal.

## Privacy

Location is only requested on demand and used on-device to sort by distance.
It is never transmitted. See `docs/privacy-terms-routes.md`.
