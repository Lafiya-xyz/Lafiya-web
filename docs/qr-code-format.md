# QR Code Format

This document describes the payload encoded in the Lafiya emergency QR code and the rationale for the chosen generation options. The implementation is in [`lib/qr/generateQrDataUrl.ts`](../lib/qr/generateQrDataUrl.ts).

## What gets encoded

The QR code encodes a plain HTTPS URL — the public emergency page for a specific patient card:

```
https://<host>/card/<capability>
```

Where `<capability>` is a 256-bit, versioned, URL-safe token (see [ADR-003](adr-003-emergency-access-capabilities.md)). The QR code contains no health data, no PII, and no secrets — it is simply a link. Everything sensitive lives in the Supabase data layer, accessible only through the app's Row-Level Security policies.

## Generation options

| Option | Value | Reason |
|---|---|---|
| `errorCorrectionLevel` | `Q` (Quartile — ~25% recovery) | Survives significant physical damage — a cracked phone screen, a faded or partially torn printout. `H` (30%) would be safer but produces a denser code; `Q` gives a good balance between scan reliability and code density at the target print size. |
| `width` | `400` px | Produces a QR image large enough to print clearly at ≥32 mm (the recommended minimum for reliable scanning across a variety of handheld scanners and phone cameras). Displayed at smaller sizes on screen via CSS; the high-resolution source avoids aliasing when printed. |
| `margin` | `4` modules | The ISO/IEC 18004 standard specifies a minimum quiet zone of 4 modules around the symbol. Omitting or reducing the margin is a common cause of scan failure, especially on white backgrounds with no visible border. |

## Encoding format

The QR code uses byte mode (the `qrcode` library default), which encodes the URL as UTF-8. HTTPS URLs consisting of ASCII characters produce compact output in this mode. No structured append is used; the entire payload fits in a single QR symbol.

## Output format

`generateQrDataUrl` returns a `data:image/png;base64,…` string. This can be set directly as the `src` of an `<img>` element with no additional route, server round-trip, or client-side JavaScript needed to render it. The image is generated server-side at profile-edit time and stored implicitly via React's rendering — it is not cached separately.

## Scan reliability considerations

The combination of Q-level error correction, 400 px width, and a 4-module quiet zone means the code should scan reliably from:

- A phone screen at ≥50% brightness (tested in low-light emergency scenarios)
- A printed A4 or letter page at standard resolution (≥300 dpi)
- A faded or partially obstructed printout (up to ~25% symbol damage)

If the QR options ever need to be changed — for example to support a smaller print format or a higher-density payload — the tradeoff to preserve is: ECC level ≥ `Q`, width ≥ `300`, margin ≥ `4`. Going below any of these risks real-world scan failures in exactly the conditions (bad lighting, damaged printout, cracked screen) where this product is used.

## Verification: decode round-trip and damage simulation

Every capability URL format we issue is proven decodable, not just
generatable, by [`lib/qr/generateQrDataUrl.damage.test.ts`](../lib/qr/generateQrDataUrl.damage.test.ts), which runs in CI as part of `npm test`.

**Decoder.** The harness decodes generated PNGs with [`jsQR`](https://github.com/cozmo/jsQR) (a pure-JS QR decoder — no native/canvas dependency), after reading the PNG's raw RGBA pixels with [`pngjs`](https://github.com/lukeapage/pngjs). Both are dev-only dependencies (`lib/qr/decodeQr.ts`); production code never depends on a decoder.

**Round-trip.** For each capability URL format — the legacy `/card/<uuid>` link and the current `/card/c/<capability>` link (ADR-003) — the harness generates a QR, decodes it, and asserts the decoded text is byte-for-byte identical to the input.

**Damage simulation** (`lib/qr/qrDamageSimulation.ts`), applied to the generated symbol's raw pixels before decoding:

| Transform | Parameters | Simulates |
|---|---|---|
| Gaussian blur | 3-pass box blur, radius 2 | Camera motion blur / out-of-focus phone scan |
| Random occlusion | ~15% of area, opaque mid-gray blocks | A thumb, sticker, or lamination bubble partially covering the symbol |
| Low contrast | Pixel values pulled 60% toward mid-gray | A faded or sun-bleached printout |
| Downscale | Nearest-neighbor to 150 px | The print-scaling / low-resolution preview artefacts of a small laminated card |
| Combined | Blur (radius 1) → occlusion (~10%) → low contrast (35%) → downscale (150 px) | A realistic worst case: several forms of damage at once |

Each transform is applied individually, and once combined, to every URL format. The suite also runs a property-style test over eight randomly generated (deterministically seeded) capability tokens at their fixed real-world length — a versioned, base64url-encoded 256-bit token, `v1.` + 43 characters, per ADR-003 — asserting every one of them decodes correctly after every damage transform.

**Evidence.** With the current parameters (ECC `Q`, 400 px, 4-module margin), all cases above decode successfully for both URL formats. This is well within headroom: Q-level error correction tolerates ~25% codeword damage, and the transforms above are calibrated to be a meaningful stress test without exceeding what a real laminated card in normal use would suffer. If a future change to these parameters, the URL scheme, or the capability token length causes this suite to fail, that is a signal the change risks real-world scan failures and needs re-tuning before shipping — see the "Generation options" trade-offs above for the floor on each parameter.

## Relationship to the offline-first emergency page

The QR encodes a URL, not a data snapshot. The emergency page at that URL:

1. Serves live data from Supabase when online.
2. Falls back to a service-worker-cached envelope when offline (see [card-caching-strategy.md](card-caching-strategy.md)).

The QR code itself never needs to change when the patient's record changes — the same URL always resolves to the current record.
