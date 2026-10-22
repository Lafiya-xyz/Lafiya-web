import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

/**
 * NTAG 424 DNA "Secure Unique NFC" (SUN) message verification — spike for
 * issue #772. See docs/ntag424-sun-spike.md for the threat analysis and
 * adoption plan.
 *
 * Tag URL template: `/api/nfc/sun?picc=<32 hex>&cmac=<16 hex>`.
 * - `picc` is PICCData (tag 0xC7: UID + read counter mirrored) encrypted with
 *   AES-128-CBC, zero IV, under the per-tag SDM meta-read key.
 * - `cmac` is the truncated AES-CMAC (odd bytes) over an empty input, keyed
 *   with a session key derived from the per-tag SDM file-read key, UID and
 *   counter (NXP AN12196 §4.4).
 *
 * Per-tag keys are diversified from a master key with HMAC-SHA256 so the
 * server stores one secret, not one per tag.
 */

const ZERO_IV = Buffer.alloc(16);
const RB = 0x87;

function aesEcb(key: Buffer, block: Buffer): Buffer {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}

function shiftLeft(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] =
      ((buf[i] << 1) | (i + 1 < buf.length ? buf[i + 1] >> 7 : 0)) & 0xff;
  }
  return out;
}

function subkey(k: Buffer): Buffer {
  const s = shiftLeft(k);
  if (k[0] & 0x80) s[15] ^= RB;
  return s;
}

/** AES-CMAC (RFC 4493). */
export function aesCmac(key: Buffer, message: Buffer): Buffer {
  const k1 = subkey(aesEcb(key, Buffer.alloc(16)));
  const k2 = subkey(k1);
  const n = Math.max(1, Math.ceil(message.length / 16));
  const complete = message.length > 0 && message.length % 16 === 0;
  const last = Buffer.alloc(16);
  message.copy(last, 0, (n - 1) * 16);
  if (!complete) last[message.length - (n - 1) * 16] = 0x80;
  const sub = complete ? k1 : k2;
  for (let i = 0; i < 16; i++) last[i] ^= sub[i];

  let x: Buffer = Buffer.alloc(16);
  for (let b = 0; b < n - 1; b++) {
    const block = message.subarray(b * 16, b * 16 + 16);
    for (let i = 0; i < 16; i++) x[i] ^= block[i];
    x = aesEcb(key, x);
  }
  for (let i = 0; i < 16; i++) x[i] ^= last[i];
  return aesEcb(key, x);
}

export interface TagKeys {
  metaReadKey: Buffer;
  fileReadKey: Buffer;
}

/** Meta-read key is shared across tags: the UID is only known after decryption. */
export function deriveMetaReadKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey)
    .update("sdm-meta-read")
    .digest()
    .subarray(0, 16);
}

/** Derives the AES-128 keys to provision onto one tag; the MAC key is per-UID. */
export function deriveTagKeys(masterKey: Buffer, uid: Buffer): TagKeys {
  return {
    metaReadKey: deriveMetaReadKey(masterKey),
    fileReadKey: createHmac("sha256", masterKey)
      .update("sdm-file-read")
      .update(uid)
      .digest()
      .subarray(0, 16),
  };
}

function sessionMacKey(
  fileReadKey: Buffer,
  uid: Buffer,
  counter: Buffer,
): Buffer {
  const sv2 = Buffer.concat([
    Buffer.from([0x3c, 0xc3, 0x00, 0x01, 0x00, 0x80]),
    uid,
    counter,
  ]);
  return aesCmac(fileReadKey, sv2);
}

export function truncateMac(full: Buffer): Buffer {
  return Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map((i) => full[i]));
}

export function computeSunMac(
  fileReadKey: Buffer,
  uid: Buffer,
  counter: number,
): Buffer {
  const ctr = Buffer.from([
    counter & 0xff,
    (counter >> 8) & 0xff,
    (counter >> 16) & 0xff,
  ]);
  return truncateMac(
    aesCmac(sessionMacKey(fileReadKey, uid, ctr), Buffer.alloc(0)),
  );
}

export function encryptPiccData(
  metaReadKey: Buffer,
  uid: Buffer,
  counter: number,
): Buffer {
  const plain = Buffer.alloc(16);
  plain[0] = 0xc7;
  uid.copy(plain, 1);
  plain.writeUIntLE(counter, 8, 3);
  const c = createCipheriv("aes-128-cbc", metaReadKey, ZERO_IV);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]);
}

/** Last accepted counter per UID; implementations must update atomically (compare-and-set). */
export interface SunCounterStore {
  /** Stores `counter` only if greater than the stored value; returns whether it did. */
  advance(uidHex: string, counter: number): Promise<boolean>;
}

export type SunResult =
  | { ok: true; uid: string; counter: number }
  | { ok: false; reason: "MALFORMED" | "TAMPERED" | "REPLAYED" };

export async function verifySunMessage(
  params: { picc: string; cmac: string },
  masterKey: Buffer,
  counters: SunCounterStore,
): Promise<SunResult> {
  if (
    !/^[0-9a-fA-F]{32}$/.test(params.picc) ||
    !/^[0-9a-fA-F]{16}$/.test(params.cmac)
  ) {
    return { ok: false, reason: "MALFORMED" };
  }
  const d = createDecipheriv(
    "aes-128-cbc",
    deriveMetaReadKey(masterKey),
    ZERO_IV,
  );
  d.setAutoPadding(false);
  const plain = Buffer.concat([
    d.update(Buffer.from(params.picc, "hex")),
    d.final(),
  ]);
  if (plain[0] !== 0xc7) return { ok: false, reason: "TAMPERED" };

  const uid = plain.subarray(1, 8);
  const counter = plain.readUIntLE(8, 3);
  const expected = computeSunMac(
    deriveTagKeys(masterKey, uid).fileReadKey,
    uid,
    counter,
  );
  const given = Buffer.from(params.cmac, "hex");
  if (!timingSafeEqual(expected, given))
    return { ok: false, reason: "TAMPERED" };

  const uidHex = uid.toString("hex");
  if (!(await counters.advance(uidHex, counter)))
    return { ok: false, reason: "REPLAYED" };
  return { ok: true, uid: uidHex, counter };
}

/** Single-process counter store for tests and the spike route. */
export function memoryCounterStore(): SunCounterStore {
  const last = new Map<string, number>();
  return {
    async advance(uidHex, counter) {
      if (counter <= (last.get(uidHex) ?? -1)) return false;
      last.set(uidHex, counter);
      return true;
    },
  };
}
