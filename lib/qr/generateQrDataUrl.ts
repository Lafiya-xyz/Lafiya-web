/**
 * @module generateQrDataUrl
 *
 * Generates the emergency QR code for a Lafiya card.
 *
 * ## What gets encoded
 * A plain HTTPS URL — the public emergency page for this patient
 * (`https://<host>/card/<capability>`). No health data, no PII, no secrets.
 * Everything sensitive lives behind Supabase RLS; the QR is just a link.
 *
 * ## QR options and why they were chosen
 *
 * | Option                | Value | Rationale                                                    |
 * |-----------------------|-------|--------------------------------------------------------------|
 * | errorCorrectionLevel  | Q     | ~25% codeword recovery — survives a cracked screen or faded  |
 * |                       |       | printout. H (30%) is denser; Q is the best legibility        |
 * |                       |       | trade-off at the 400 px target size.                         |
 * | width                 | 400   | Sharp enough to print at ≥32 mm (reliable scan floor for     |
 * |                       |       | handheld scanners and phone cameras). CSS scales it down for  |
 * |                       |       | on-screen display without aliasing on print.                 |
 * | margin                | 4     | ISO/IEC 18004 minimum quiet zone. Fewer modules is a common  |
 * |                       |       | cause of scan failure on white backgrounds.                  |
 *
 * Do not reduce ECC below Q, width below 300, or margin below 4 — any of
 * these can cause real-world scan failures in low-light or damaged-printout
 * conditions, exactly where this product is used.
 *
 * See also: docs/qr-code-format.md for the full payload specification.
 */
import QRCode from "qrcode";

/**
 * Renders `text` (the public card URL) as a scannable QR code, returned as a
 * data: URL so it can be embedded directly in an <img> with no extra route
 * or client JS needed to display it.
 */
export async function generateQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    // Emergency print guidance: Q tolerates roughly 25% codeword damage;
    // four modules of quiet zone and 400px output support a >=32mm print.
    errorCorrectionLevel: "Q",
    margin: 4,
    width: 400,
  });
}
