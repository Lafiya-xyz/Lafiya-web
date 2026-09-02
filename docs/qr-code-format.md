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

## Relationship to the offline-first emergency page

The QR encodes a URL, not a data snapshot. The emergency page at that URL:

1. Serves live data from Supabase when online.
2. Falls back to a service-worker-cached envelope when offline (see [card-caching-strategy.md](card-caching-strategy.md)).

The QR code itself never needs to change when the patient's record changes — the same URL always resolves to the current record.
