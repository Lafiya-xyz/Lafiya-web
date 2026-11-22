/**
 * SMS encoding and segment accounting (issue #955).
 *
 * Providers bill per segment. A message is GSM-7 only if every character is in
 * the GSM 03.38 basic or extension table; otherwise it is UCS-2. Single-part
 * limits are 160 (GSM-7) / 70 (UCS-2) characters; concatenated parts carry a
 * 6-byte UDH, leaving 153 / 67 characters per segment.
 */

/** GSM 03.38 basic character set. */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** GSM 03.38 extension characters (each costs two septets). */
const GSM7_EXTENSION = "^{}\\[~]|€";

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENSION_SET = new Set(GSM7_EXTENSION);

export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SmsSegmentInfo {
  encoding: SmsEncoding;
  /** Billable characters (extension chars count twice in GSM-7). */
  length: number;
  segments: number;
  /** Characters still available in the last segment. */
  remaining: number;
}

/** True when every character is representable in GSM 03.38. */
export function isGsm7(text: string): boolean {
  for (const char of text) {
    if (!GSM7_BASIC_SET.has(char) && !GSM7_EXTENSION_SET.has(char)) return false;
  }
  return true;
}

/** Compute encoding, length and segment count for an SMS body. */
export function smsSegments(text: string): SmsSegmentInfo {
  const gsm7 = isGsm7(text);
  const encoding: SmsEncoding = gsm7 ? "GSM-7" : "UCS-2";

  let length = 0;
  for (const char of text) {
    length += gsm7 && GSM7_EXTENSION_SET.has(char) ? 2 : 1;
  }

  const single = gsm7 ? 160 : 70;
  const multi = gsm7 ? 153 : 67;

  if (length <= single) {
    return { encoding, length, segments: 1, remaining: single - length };
  }

  const segments = Math.ceil(length / multi);
  return { encoding, length, segments, remaining: segments * multi - length };
}

/** True when the message fits within `budget` segments. */
export function fitsSegmentBudget(text: string, budget: number): boolean {
  return smsSegments(text).segments <= budget;
}
