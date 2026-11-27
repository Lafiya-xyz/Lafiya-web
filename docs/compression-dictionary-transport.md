# Compression Dictionary Transport (Issue #879)

**Status:** Evaluated. Deferred for Next.js chunks; the tooling is ready.

## What it is

With [Compression Dictionary Transport](https://datatracker.ietf.org/doc/draft-ietf-httpbis-compression-dictionary/),
a response marked `Use-As-Dictionary: match="/path/*"` can later serve as the
dictionary for a newer version of the same resource. The browser advertises it
with `Available-Dictionary: :<sha-256>:`, and the server replies with a `dcb`
(brotli) or `dcz` (zstd) delta.

## Measured savings (real release diff)

`scripts/build-dictionary-variants.mjs` compared the directly-served
`public/` JS between two merged releases (`7d793c5` → `27b0066`):

| Asset                      | Raw (B) | Brotli q11 (B) | `dcz` vs previous (B) |
| -------------------------- | ------- | -------------- | --------------------- |
| `offline-cache-helpers.js` | 32 279  | 9 059          | 1 326                 |
| `sw.js`                    | 7 768   | 2 295          | 1 702                 |
| **Total**                  |         | **11 354**     | **3 028 (−73.3 %)**   |

Reproduce:

```bash
git archive 7d793c5 public | tar -x -C /tmp/prev
git archive 27b0066 public | tar -x -C /tmp/curr
node scripts/build-dictionary-variants.mjs --prev /tmp/prev/public --curr /tmp/curr/public --out /tmp/dcz
```

Two runs produce byte-identical `.dcz` files. Inputs are sorted, the zstd level
is fixed and nothing time-dependent is embedded, so CI can generate the
variants deterministically.

## Decision

1. **Hosting doesn't support it yet.** Vercel's edge doesn't negotiate
   `Available-Dictionary` and can't serve a prebuilt `.dcz` variant for a
   static asset. Turning it on means moving `/_next/static` behind a CDN or
   Worker that does the negotiation. That's an infra change, out of scope for
   this spike.
2. **Turbopack chunk names are content hashes only** (e.g.
   `014jasjud3afe.js`), with no stable logical prefix. A `match` pattern can't
   pair a new chunk with its predecessor by URL. Pairing needs a build
   manifest that maps chunk to entry point. `logicalName()` in the script
   handles `name-<hash>.js` assets only.
3. **Adopt first for the stable-URL assets** (`/sw.js`,
   `/offline-cache-helpers.js`, facility-directory shards) once the CDN can
   negotiate. These are the assets measured above, and they need no chunk
   pairing.

## Fallback behaviour

Clients that don't send `Available-Dictionary` (Firefox and Safari today, or
any client with an evicted dictionary) get the normal brotli/gzip response.
The server must send `Vary: Accept-Encoding, Available-Dictionary` so caches
don't serve a delta to a client that lacks the dictionary. No client-side
code changes.
