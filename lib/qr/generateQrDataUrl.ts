import QRCode from "qrcode";

/**
 * Thrown when the input URL exceeds the QR code's maximum data capacity for
 * the configured error-correction level and symbol size.
 *
 * Callers must catch this and surface a clear message to the user rather than
 * propagating a raw library error, which would appear as a generic crash.
 */
export class QrCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrCapacityError";
  }
}

/**
 * Renders `text` (the public card URL) as a scannable QR code, returned as a
 * data: URL so it can be embedded directly in an <img> with no extra route
 * or client JS needed to display it.
 *
 * @throws {QrCapacityError} if `text` exceeds the QR symbol's capacity.
 *   This happens deterministically for oversized inputs — never silently
 *   producing a corrupted/unscannable code.
 */
export async function generateQrDataUrl(text: string): Promise<string> {
  try {
    return await QRCode.toDataURL(text, {
      // Emergency print guidance: Q tolerates roughly 25% codeword damage;
      // four modules of quiet zone and 400px output support a >=32mm print.
      errorCorrectionLevel: "Q",
      margin: 4,
      width: 400,
    });
  } catch (error) {
    // The qrcode library throws a plain Error whose message mentions that
    // the data is "too big" when the input exceeds the maximum QR capacity.
    // Translate this into a typed, catchable error so call sites can
    // show a clear message rather than leaking raw library internals.
    const msg = error instanceof Error ? error.message : String(error);
    if (/too big|overflow|too long|capacity/i.test(msg)) {
      throw new QrCapacityError(
        "The emergency card URL is too long to encode as a QR code. " +
          "Contact support if this persists.",
      );
    }
    throw error;
  }
}
