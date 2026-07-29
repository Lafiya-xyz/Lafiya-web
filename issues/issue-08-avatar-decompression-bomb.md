## Title
Harden the avatar upload pipeline against pixel-flood/decompression-bomb images with a pre-decode dimension budget and per-user concurrency control

## Difficulty
10/10 — Expert. Estimated effort: 3–4 days for a senior engineer.

## Context
`app/api/profile/photo/route.ts` accepts an authenticated patient's photo upload, validates only MIME type (`ALLOWED_TYPES`, line 6) and byte size (`MAX_BYTES = 5 * 1024 * 1024`, line 7), then unconditionally calls `sharp(buffer).metadata()` followed by `.resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })` and a full re-encode. `metadata()` reads only the image's header/container information (cheap — no full pixel decode); the actual expensive work — full decompression of every pixel into memory, followed by a resize operation that itself must touch every source pixel — happens unconditionally in `.resize()`/`.toBuffer()`, with **no check on `metadata.width`/`metadata.height` before that point** (route.ts:47-61 reads `metadata.format` only; `metadata.width`/`metadata.height` are never inspected).

PNG, WebP, and JPEG all support highly compressible images with enormous pixel dimensions relative to their compressed file size — a uniform-color or simple-pattern image at, say, 15000×15000 pixels (225 million pixels, still under `sharp`'s own default `pixelLimit` safety threshold of ~268 million pixels, meaning `sharp` will not refuse it) compresses to a file easily well under this route's 5 MB ceiling, yet requires decoding and holding roughly 900 MB+ of raw RGBA pixel data in memory (15000 × 15000 × 4 bytes) and performing real CPU work to resize it — on every request. Because this route requires only an authenticated session (any signed-up patient, not an elevated role) and has no rate limiting or per-user concurrency cap anywhere in its path (`proxy.ts` only redirects unauthenticated `/profile` access; it does not rate-limit `/api/profile/photo`), an attacker with one legitimate account can fire several such uploads concurrently and repeatedly, each cheap to send (well under 5 MB on the wire) but expensive to process, to exhaust the memory or CPU budget of whatever compute is serving this route — a classic decompression-bomb / pixel-flood denial-of-service vector that the current size-and-MIME-type checks do nothing to prevent, because file size and pixel count are only loosely correlated for adversarially-crafted images.

## Problem statement
Add a pre-decode dimension budget to the avatar upload pipeline that rejects images whose declared pixel dimensions exceed a sane bound for this product's actual output target (an 80×80-displayed avatar, resized server-side to a maximum of 800×800 per the existing `resize` call) **before** any full-pixel decode is performed, for every accepted format (PNG, JPEG, WebP), and add a per-user concurrency/rate control so that even a legitimately-dimensioned-but-repeated upload burst from one account cannot exhaust shared compute resources.

## Current behavior
- `app/api/profile/photo/route.ts:44-61` — `sharp(buffer)`, then `sharpInstance.metadata()`, checking only `metadata.format` truthiness. `metadata.width`/`metadata.height` are computed by this same call (cheaply, from the container header) but discarded.
- `app/api/profile/photo/route.ts:56-61` — `.resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true })` runs unconditionally immediately after, which for `fit: "inside"` still requires a full decode of the source image regardless of how small the *output* will be.
- No test fixture or test case in `tests/avatar-upload.test.ts` (or anywhere else in the repo) exercises an oversized-dimension image; the existing `tests/fixtures/gps-tagged.jpg` fixture tests EXIF stripping, not dimension limits.
- No rate limiting or per-user concurrency cap exists on this route (contrast with `app/(auth)/signin/actions.ts`, which has one, albeit a broken one per the related issue in this batch).

## Required behavior
- The route must read only the cheap header/container metadata (`sharp(buffer).metadata()`, which does not require a full pixel decode) and reject — before calling `.resize()` or any other operation that would decode full pixel data — any image whose declared `width × height` exceeds a documented, justified maximum (reasoned from the fact that the final output is capped at 800×800; there is no legitimate reason to accept a source image dramatically larger than what could ever be needed, and you must pick and justify a specific multiplier/ceiling).
- The rejection must be format-agnostic and correct: an adversary who crafts a PNG, JPEG, or WebP file with a header claiming small dimensions but actual pixel data that decodes to something larger (or vice versa — inconsistent/malformed headers) must not be able to bypass the check by exploiting a mismatch between what `sharp`'s cheap metadata read reports and what the full decode actually produces; you must verify (with adversarial test fixtures, not just reasoning) that `sharp`'s `metadata()` call cannot be lied to by a crafted file in a way that lets an oversized decode slip through.
- A per-user concurrency/frequency control on this route (in addition to, and independent of, the dimension check) so that a burst of concurrently-submitted, individually-within-budget uploads from a single account cannot still exhaust shared CPU/memory by sheer parallelism.
- The route must continue to correctly process legitimate photos (JPEG/PNG/WebP, including the existing GPS-EXIF-stripping behavior tested by `tests/avatar-upload.test.ts`) with no regression.

## Constraints
- No new heavyweight dependency — use `sharp`'s existing metadata/decode APIs and this project's existing patterns (Next.js Route Handlers, no new job queue).
- Must not change the public `POST /api/profile/photo` request/response contract (`multipart/form-data` with a `file` field; `{ publicUrl }` or `{ error }` JSON response) in a way that breaks `app/(auth)/profile/photo-upload-field.tsx`'s existing client usage, unless you also update that caller and its tests.
- Must preserve the existing EXIF-stripping and 800×800-max-output behavior exactly.
- Do not rely on repository snapshots or point-in-time repo states; work against the live default branch only.

## Acceptance criteria
- [ ] The route rejects an image whose header-declared dimensions exceed the chosen ceiling with a 400 response, measurably (via a test asserting response status/time) *before* performing a full pixel decode — demonstrate this by proving the rejection path's CPU/wall-time cost is roughly constant regardless of how large the (rejected) image's declared dimensions are, unlike the accept path.
- [ ] At least three adversarial test fixtures are added (crafted, not just described): a PNG, a JPEG, and a WebP file, each with pixel dimensions large enough to be dangerous (e.g., >6000×6000) but a small file size, proving each is rejected pre-decode.
- [ ] A test proving a legitimate, normally-dimensioned photo (reusing or extending the existing `tests/fixtures/gps-tagged.jpg` pattern) still uploads, resizes, and strips EXIF correctly — no regression.
- [ ] A test or documented benchmark proving that N concurrent uploads from the same authenticated user beyond a configured concurrency/frequency budget are rejected or queued rather than all processed simultaneously.
- [ ] `npx vitest run tests/avatar-upload.test.ts` passes in full, including the new adversarial cases.
- [ ] `npm run typecheck` and `npm run lint` pass.

## Out of scope
- The distributed rate-limiting infrastructure issue elsewhere in this batch (that issue is about sign-in brute-force protection specifically) — you may reuse whatever backend that issue produces if it lands first, but this issue must be independently workable and may implement its own minimal per-user concurrency control if that issue hasn't landed.
- Malware/virus scanning of uploaded images — out of scope; this issue is specifically about the decompression-bomb/resource-exhaustion vector.
- Any change to the `avatars` Supabase Storage bucket's own size/MIME limits (`supabase/migrations/20260709122523_avatars_bucket_limits.sql`) unless you determine a change there is strictly necessary to support your fix.

## Hints and references
- `sharp`'s documented `limitInputPixels` option and its default value/behavior (`https://sharp.pixelplumbing.com/api-constructor` — the `limitInputPixels` constructor option), and why relying on its default alone is insufficient here (the default threshold is far above what this product's 800×800 output target ever needs).
- The general "image bomb" / "pixel flood" vulnerability class (see OWASP's guidance on file upload resource-exhaustion attacks) for adversarial-fixture construction techniques (e.g., a PNG using a solid-color IDAT stream compresses enormous dimensions into a tiny file via zlib's handling of repetitive data).
- Node.js `sharp` metadata-only reads vs. full decode cost — the library's own documentation on `metadata()` explicitly not requiring a full decode is the basis for why a pre-check is cheap and viable here.
