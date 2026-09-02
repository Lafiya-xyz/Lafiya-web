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
