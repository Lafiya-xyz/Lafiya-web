# ADR 004: Short-link domain for QR payloads

Status: **accepted** (prototype on subpath; domain acquisition deferred) — issue #627.

## Context

Lafiya emergency QR codes encode the full capability URL:

```
https://<host>/card/c/<capability>
```

The current host is `lafiya.xyz` (40 characters), and the capability token is 53 characters (`lafiya_e1_` prefix + 43 base64url chars), giving a total URL of roughly **100 characters** including the scheme and path separator.

At QR error-correction level Q (25% recovery) and a 400 px render width, 100 ASCII characters produce a QR Version 6 symbol (41 × 41 modules).  At the target printed size of ≥ 32 mm, each module is approximately 0.78 mm — well above the 0.25 mm scan-floor for modern phone cameras.

However, printed cards become worn.  A shorter URL would lower the QR version and increase module size, making codes more resilient on degraded prints.

## Analysis

### URL length and QR version

| URL length (bytes, ASCII) | QR Version (ECC Q) | Module size @ 32 mm |
|---------------------------|--------------------|---------------------|
| ~100 (current)            | 6 (41 × 41)        | ~0.78 mm            |
| ~40 (short domain)        | 3 (29 × 29)        | ~1.10 mm            |
| ~55 (subpath prototype)   | 4 (33 × 33)        | ~0.97 mm            |

A dedicated short domain such as `lfy.ng` (6 characters including `.`) could reduce the QR to Version 3, increasing module size by ~41%.  Even a subpath prototype (`lafiya.xyz/r/<code>`) achieves Version 4 with a meaningful gain.

### Short code design

- **Entropy**: 64 random bits encoded as 11 base62 characters gives 1 in 10¹⁸ guessing probability, sufficient against enumeration.
- **Mapping**: short codes map to `card_public_id` (the non-secret UUID used for the static card route), NOT to capability tokens.  The capability token remains long for its security guarantee; only the public card link is shortened.
- **Re-pointability**: updating `profiles.card_public_id` transparently re-points the short link since the redirect reads the current value.
- **Revocation**: deleting the `short_links` row immediately stops the redirect with a 404 — no separate revocation step.

### Threat model

| Threat | Mitigation |
|--------|------------|
| Redirect log leaks card_public_id | `Referrer-Policy: no-referrer` on the redirect response; short_links table never stores the capability token |
| Domain takeover | Use a subpath on the main domain until a dedicated domain with DNSSEC and CAA records is acquired |
| Enumeration | 64-bit entropy code (11 base62 chars); rate-limit /r/ route at the CDN layer |
| Offline behaviour | The service worker must cache both the full URL and the short URL as equivalent cache keys; the redirect is transparent at the HTTP layer |
| Token log in provider analytics | Ensure CDN/reverse proxy does not log the redirect target; strip query parameters before logging |

### Domain acquisition

Buying `lfy.ng` is **out of scope** for this issue.  The prototype redirect is implemented on the subpath `/r/<code>` of the main domain.  A domain migration is a separate ADR.

## Decision

1. Implement a `/r/<code>` redirect prototype on the main domain (this issue).
2. Short codes map to `card_public_id` only; the capability token path is unchanged.
3. Do not shorten capability token URLs — they carry bearer-token semantics and any shortening service adds a trust surface to the auth path.
4. Set `Referrer-Policy: no-referrer` on all redirect responses.
5. Revisit `lfy.ng` acquisition in a future ADR once the prototype is validated at scale.

## Consequences

- QR module size increases from ~0.78 mm to ~0.97 mm at 32 mm print size.
- Printed cards issued before this change continue to work via the existing `/card/<id>` route.
- A new `short_links` table is required (see migration `20260927000003_short_links.sql`).
- The service worker must be updated to treat `/r/<code>` redirects as equivalent to `/card/<id>` for cache lookup (tracked separately).
