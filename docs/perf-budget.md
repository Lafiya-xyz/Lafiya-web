# Lafiya Card — Payload Budget

Route: `app/(public)/card/[id]`  
Updated: 2026-07-18

---

## Why this budget exists

The emergency card page is the one page in Lafiya that must load fast under
the worst conditions a responder is likely to encounter in the field:

- **2G EDGE** (~250 kbps effective throughput, ~400 ms RTT)
- **Intermittent 3G** (~1.5 Mbps effective, ~100 ms RTT)
- **Offline** (service worker cache hit — zero bytes over the wire)

A patient printed the card or the responder scanned a QR code. That person
is waiting for the page to tell them the patient's blood group, genotype, and
drug allergies. Every kilobyte that isn't "blood group" is waste.

---

## Budget targets

These are _per-navigation_ transfer sizes for a cold (uncached) load:

| Asset category          | Budget       | Notes                                                    |
| ----------------------- | ------------ | -------------------------------------------------------- |
| HTML document           | ≤ 5 kB       | Server-rendered; inline CSS vars; no client JS required  |
| CSS (all chunks)        | ≤ 15 kB      | Tailwind purged + print.css; gzip/brotli in production   |
| JavaScript (all chunks) | ≤ 50 kB      | React + Next.js runtime; no heavy client components here |
| Fonts                   | **0 kB**     | System fonts only on this route (layout.tsx override)    |
| Patient photo           | ≤ 40 kB      | Supabase Storage upload-time resize target (see below)   |
| **Total (no photo)**    | **≤ 70 kB**  | The critical path without user-uploaded content          |
| **Total (with photo)**  | **≤ 110 kB** | Worst-case including a reasonably sized avatar           |

On a 2G EDGE connection (250 kbps) 110 kB = ~3.5 seconds to transfer.
Combined with a ~400 ms RTT for the first HTML byte, the page should be
fully readable in under 5 seconds on EDGE — acceptable for a non-interactive,
information-only page.

---

## What each line means

### HTML

The page is fully server-rendered (`export const dynamic = "force-dynamic"`).
No skeleton + data fetch: the patient's name, blood group, genotype, allergies,
medications, and contacts are all in the first HTML response. This is the right
tradeoff for emergency data.

### CSS

Tailwind v4 purges unused utilities at build time. `print.css` is ~3 kB
uncompressed; it is gzip/brotli compressed in production and only downloaded
when the browser indicates a print intent (the `@media print` block is inert
during normal screen rendering). The route-scoped CSS chunk should stay well
under 15 kB compressed.

### JavaScript

The page has no client-side components (no `"use client"` directive). React
and Next.js runtime chunks are shared across routes and cached after the first
navigation. First-visit cost is ~40–50 kB (React + Next.js minimal runtime);
subsequent navigations pay nothing for JS.

### Fonts — 0 kB (target)

`app/(public)/card/[id]/layout.tsx` resets `--font-sans` and `--font-mono` to
system-font stacks before any paint. The root layout's `next/font` Geist
declaration still runs at the HTML level and `font-display: swap` is in effect,
but on this route the variables those fonts populate are immediately overridden
so the system font is used for every element on the page.

The net result: no `preconnect fonts.gstatic.com`, no WOFF2 download, no
font-swap flash, no blocked paint. The Geist WOFF2 files (~30–50 kB) are never
fetched for this route.

> **Future hardening**: consider extracting the card route into its own `<html>`
> tree (a root-level `(card)` route group) so `next/font` doesn't even inject
> the `preconnect` link for this route. For M0 the layout override is
> sufficient.

### Patient photo

The photo `<img>` renders at 80×80 CSS pixels (160×160 px at 2×). The
Supabase Storage upload pipeline should resize-on-upload and cap avatars at
200×200 px / JPEG 85% quality — this is a **code-adjacent convention**, not
an enforced server-side constraint today. Target: ≤ 40 kB per photo.

The `<img>` is already marked `loading="eager"` + `fetchPriority="high"` so
the browser starts fetching it as soon as the HTML is parsed.

---

## Measuring against the budget

### Local (one-off check)

```bash
# 1. Build the app
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy \
  SUPABASE_SERVICE_ROLE_KEY=dummy \
  STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
  SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
  npm run build

# 2. Inspect the generated CSS bundle for the card route
ls -lh .next/static/css/

# 3. Use Next.js build output — JS chunk sizes are printed to stdout.
#    Look for the line that includes "(public)/card/[id]".
```

For a more detailed breakdown, set `ANALYZE=true` (see CI section below).

### Lighthouse (recommended before any M0 deployment)

Run Lighthouse against the seeded demo card
(`/card/11111111-1111-1111-1111-111111111111`) with the "Slow 4G" throttle
preset. Targets:

| Metric                   | Target   |
| ------------------------ | -------- |
| First Contentful Paint   | ≤ 2.5 s  |
| Largest Contentful Paint | ≤ 3.5 s  |
| Total Blocking Time      | ≤ 200 ms |
| Total transfer size      | ≤ 110 kB |
| Performance score        | ≥ 90     |

---

## CI enforcement

See `.github/workflows/ci.yml`. The `bundle-size` job (added alongside this
document) fails the build if the card-route CSS chunk exceeds 20 kB or the
total JS for the route exceeds 60 kB. Thresholds are intentionally a little
above the targets above to give room for legitimate growth without constant
noise.

---

## Regression checklist for contributors

Before landing a change to `app/(public)/card/[id]`:

- [ ] No new `"use client"` component added unless strictly necessary
- [ ] No new `import` of a library that isn't already in the bundle
- [ ] No `next/font` or `@font-face` declaration added to the card route or its layout
- [ ] Any new image follows the 200×200 px / ≤ 40 kB upload convention
- [ ] `npm run build` output shows no increase in JS chunk size for this route
- [ ] Print stylesheet tested in browser (`Ctrl+P` or `⌘+P`) — all sections visible, no dark backgrounds, badge legible
