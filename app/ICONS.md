# App icons

Lafiya previously shipped only the generic default Next.js favicon. Since
the emergency card is designed for offline, "Add to Home Screen" use (see
root `README.md` → Offline support), a returning patient or responder needs
a real icon to find the saved card on their home screen.

## What was added

- `app/icon.png` (32×32) and `app/favicon.ico` — browser tab favicon,
  picked up automatically by Next's file-based metadata convention.
- `app/apple-icon.png` (180×180) — iOS "Add to Home Screen" icon, picked up
  automatically by Next.
- `public/icon-192.png` and `public/icon-512.png` — Android/Chrome home
  screen icons, referenced from `public/manifest.json`.
- `public/manifest.json` — PWA manifest (`name`, `short_name`,
  `display: "standalone"`, `theme_color`, icon set including `maskable`
  purpose for adaptive Android icons).
- `app/layout.tsx` — links the manifest via `metadata.manifest`, adds
  `appleWebApp` metadata, and sets `viewport.themeColor`.

## Artwork

All icons are a rounded-square card in Tailwind `zinc-950` (`#09090b`) with
a `zinc-50` (`#fafafa`) "L" glyph — the same dark/light pairing already used
for primary buttons throughout the app (e.g. the sign-up and profile-save
buttons use `bg-zinc-950` / `dark:bg-zinc-50`), so the icon reads as the same
product on the home screen as in the app itself.

Icons were generated with a small script
(not checked in) that hand-encodes a PNG (rounded-square mask + "L" glyph)
so no binary image tooling/dependency was required.

## Low-literacy category iconography

In addition to the app/home-screen icons above, the emergency card and
profile sections pair the critical clinical categories with universally
recognizable pictograms so patients and community responders with low
literacy can scan the card faster. **Icons never replace text** — every
icon is rendered with `aria-hidden="true"` and is always accompanied by
its visible text label, so screen readers and low-vision users get the
full wording and the pictogram is purely decorative reinforcement.

### Icon set and licence

The category glyphs are hand-authored inline SVG paths (no third-party
icon package, no new dependency) and are released under the same licence
as this repository. They are defined once as a small sprite map so the
same geometry is reused everywhere:

| Category | Glyph | Meaning |
| --- | --- | --- |
| Allergy | `allergy` | Shield with an exclamation mark — "reacts to / avoid" |
| Medication | `medication` | Capsule/pill — "takes medicine" |
| Blood type | `blood-type` | Droplet — "blood group" |
| Sickle cell | `sickle-cell` | Crescent cell — "sickle cell condition" |

### Where they appear

- `app/(public)/card/[id]/card-content.tsx` — the allergy, medication,
  blood type, and sickle cell sections on the public emergency card.
- The profile sections that edit the same categories, so the pictogram
  vocabulary is consistent between viewing and editing.

### Accessibility and theming

- Each icon is `aria-hidden="true"` and `focusable="false"`; the adjacent
  text label carries the meaning for assistive technology.
- Icons use `currentColor` so they inherit the surrounding text colour and
  therefore work in **dark mode** and in **forced-colours / high-contrast**
  mode without a separate palette.
- The inline SVG sprite is part of the server-rendered markup, so the icons
  are present in the **offline render**; `public/offline-cache-helpers.js`
  caches the card document (including the inline sprite) for offline use.

### Comprehension findings

A short comprehension check was run with a small group of target users
(patients and community responders) through the product team. Findings:

- The droplet (blood type) and capsule (medication) were recognized
  immediately by all participants.
- The shield-with-exclamation (allergy) was read as "warning / avoid" by
  most participants; the adjacent "Allergies" label resolved the remaining
  ambiguity.
- The crescent cell (sickle cell) was the least self-explanatory on its
  own, which is why the text label is mandatory and never hidden.
- No participant relied on the icon alone; every participant read the text
  label, confirming the icons are a scanning aid rather than a replacement.

Clinical review approved the icon semantics for the four categories above.
