# PR: Serve profile & public-card photos through Next.js Image Optimization

## Summary

Profile photos were being rendered with `next/image` but flagged `unoptimized`, and the
public card page used a raw `<img>` tag with an eslint-disable comment claiming the remote
host was "unknown per-card, not worth allowlisting." Both bypassed Next.js's image
optimization.

The "unknown remote host" reasoning was outdated: Supabase Storage is served from the **same
configured origin** as the Supabase API (`NEXT_PUBLIC_SUPABASE_URL`) — a single known origin,
not arbitrary per-card hosts. This change allowlists that origin explicitly and routes both
photo render sites through `next/image`.

## Changes

### `next.config.ts`

- Added a `supabaseStoragePattern()` helper that parses `NEXT_PUBLIC_SUPABASE_URL` and derives
  a `remotePatterns` entry (protocol/hostname/port) for the exact configured origin.
- The derived origin is added to `images.remotePatterns`, enabling optimization for the
  configured Storage host (local dev + hosted + custom domains).
- Retained the existing fallbacks:
  - `{ protocol: "http", hostname: "127.0.0.1", port: "54321" }` — local `supabase start` default.
  - `{ protocol: "https", hostname: "*.supabase.co" }` — hosted fallback / older deployments.

### `app/(auth)/profile/photo-upload-field.tsx`

- Removed the `unoptimized` prop from the `<Image>` so the profile editor photo is optimized.

### `app/(public)/card/[id]/page.tsx`

- Replaced the raw `<img>` (and its `@next/next/no-img-element` eslint-disable comment) with
  `next/image`, keeping the existing fixed `80×80` display dimensions (`h-20 w-20`).
- Added the `next/image` import.

## Why this is safe

- Hosted Supabase Storage lives under `*.supabase.co` → already covered (and now also by the
  exact derived origin).
- Local dev Storage is served from `http://127.0.0.1:54321` (the same origin as the API) →
  already allowlisted.
- `NEXT_PUBLIC_SUPABASE_URL` is `NEXT_PUBLIC_`-prefixed and safe to read at config load time.

## Verification

- `npm run lint` — passes.
- `npm run typecheck` (`tsc --noEmit`) — passes.
- `npx next build` — succeeds (with the full env set; see note below).

## Measured payload impact

Not captured numerically — no live Storage bucket was available to produce a real before/after.
Expected impact on the **public card page** (low-bandwidth-critical audience):

- The photo (often the single largest asset, uploads up to 5 MB) is now resized to the 80×80
  display size and transcoded to `webp`/`avif` by the optimizer instead of being shipped
  byte-for-byte.
- To document the exact KB reduction in the PR: compare the Network payload of `/card/[id]`
  for a representative card before and after this change.

## Notes

- `next build` initially failed only because `lib/env.ts`'s `serverEnv` zod schema requires
  `SOROBAN_RPC_URL` (and others). This is a pre-existing environment requirement, unrelated to
  these edits; the build succeeds once the full env is provided.
