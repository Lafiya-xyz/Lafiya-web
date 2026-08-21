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
