/**
 * Minimal Soroban XDR codec for the public card hot path (Issue #880).
 *
 * The attestation lookup only needs to (a) build one read-only
 * `invokeContract` transaction envelope for `simulateTransaction` and
 * (b) decode the returned `ScVal`. Pulling `@stellar/stellar-sdk` into the
 * card function for that costs megabytes of module init on every cold start,
 * so this module hand-encodes exactly those XDR shapes and nothing else.
 *
 * It is deliberately dependency-free and is differentially tested against the
 * SDK (`soroban-lite.test.ts`). The full SDK remains the right tool for the
 * CHW / payout / SEP-10 paths; an ESLint import boundary keeps it out of the
 * card route (eslint.config.mjs).
 */

// ---------------------------------------------------------------------------
// StrKey (base32 + CRC16-XModem)

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const VERSION_ACCOUNT = 6 << 3; // 'G'
const VERSION_CONTRACT = 2 << 3; // 'C'

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of input) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("Invalid strkey character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function encodeStrKey(version: number, payload: Uint8Array): string {
  const data = new Uint8Array(payload.length + 3);
  data[0] = version;
  data.set(payload, 1);
  const crc = crc16xmodem(data.subarray(0, payload.length + 1));
  data[payload.length + 1] = crc & 0xff;
  data[payload.length + 2] = crc >>> 8;
  return base32Encode(data);
}

export function decodeStrKey(version: number, key: string): Uint8Array {
  const data = base32Decode(key);
  if (data.length !== 35 || data[0] !== version)
    throw new Error("Invalid strkey");
  const payload = data.subarray(1, 33);
  const crc = crc16xmodem(data.subarray(0, 33));
  if (data[33] !== (crc & 0xff) || data[34] !== crc >>> 8) {
    throw new Error("Invalid strkey checksum");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// XDR writer — only the shapes needed for one invokeContract envelope.

class XdrWriter {
  private chunks: number[] = [];

  u32(value: number): this {
    this.chunks.push(
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
    return this;
  }

  u64(value: bigint): this {
    return this.u32(Number((value >> BigInt(32)) & BigInt(0xffffffff))).u32(
      Number(value & BigInt(0xffffffff)),
    );
  }

  fixed(bytes: Uint8Array): this {
    for (const byte of bytes) this.chunks.push(byte);
    while (this.chunks.length % 4 !== 0) this.chunks.push(0);
    return this;
  }

  varBytes(bytes: Uint8Array): this {
    return this.u32(bytes.length).fixed(bytes);
  }

  string(value: string): this {
    return this.varBytes(new TextEncoder().encode(value));
  }

  toBase64(): string {
    return Buffer.from(this.chunks).toString("base64");
  }
}

const SCV_STRING = 14;

/**
 * Build a base64 `TransactionEnvelope` (v1) holding a single
 * `invokeContract(contractId, fn, [string args...])` operation. The source
 * account is a random throwaway key: the envelope is only ever simulated,
 * never signed or submitted.
 */
export function buildInvokeContractEnvelope(
  contractId: string,
  functionName: string,
  stringArgs: string[],
  sourceKey: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): string {
  const w = new XdrWriter();
  w.u32(2); // ENVELOPE_TYPE_TX
  // Transaction
  w.u32(0).fixed(sourceKey); // MuxedAccount: KEY_TYPE_ED25519
  w.u32(100); // fee (BASE_FEE)
  w.u64(BigInt(1)); // seqNum
  w.u32(0); // Preconditions: PRECOND_NONE
  w.u32(0); // Memo: MEMO_NONE
  w.u32(1); // operations<>
  w.u32(0); // Operation.sourceAccount: absent
  w.u32(24); // INVOKE_HOST_FUNCTION
  w.u32(0); // HOST_FUNCTION_TYPE_INVOKE_CONTRACT
  w.u32(1).fixed(decodeStrKey(VERSION_CONTRACT, contractId)); // SC_ADDRESS_TYPE_CONTRACT
  w.string(functionName);
  w.u32(stringArgs.length);
  for (const arg of stringArgs) w.u32(SCV_STRING).string(arg);
  w.u32(0); // auth<>
  w.u32(0); // Transaction.ext v0
  w.u32(0); // signatures<>
  return w.toBase64();
}

// ---------------------------------------------------------------------------
// ScVal reader

export type NativeScVal =
  | boolean
  | undefined
  | number
  | bigint
  | string
  | Uint8Array
  | NativeScVal[]
  | { [key: string]: NativeScVal };

class XdrReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u32(): number {
    const value = this.view.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  i32(): number {
    const value = this.view.getInt32(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.offset);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset);
    this.offset += 8;
    return value;
  }

  fixed(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length)
      throw new Error("XDR underflow");
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length + ((4 - (length % 4)) % 4);
    return out;
  }

  varBytes(): Uint8Array {
    return this.fixed(this.u32());
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function readAddress(r: XdrReader): string {
  const type = r.u32();
  if (type === 0) {
    if (r.u32() !== 0) throw new Error("Unsupported public key type");
    return encodeStrKey(VERSION_ACCOUNT, r.fixed(32));
  }
  if (type === 1) return encodeStrKey(VERSION_CONTRACT, r.fixed(32));
  throw new Error(`Unsupported ScAddress type ${type}`);
}

function readScVal(r: XdrReader): NativeScVal {
  const type = r.u32();
  switch (type) {
    case 0: // SCV_BOOL
      return r.u32() !== 0;
    case 1: // SCV_VOID
      return undefined;
    case 2: // SCV_ERROR
      throw new Error("Contract returned an ScError");
    case 3: // SCV_U32
      return r.u32();
    case 4: // SCV_I32
      return r.i32();
    case 5: // SCV_U64
    case 7: // SCV_TIMEPOINT
    case 8: // SCV_DURATION
      return r.u64();
    case 6: // SCV_I64
      return r.i64();
    case 9: // SCV_U128
      return (r.u64() << BigInt(64)) | r.u64();
    case 10: // SCV_I128
      return (r.i64() << BigInt(64)) | r.u64();
    case 11: // SCV_U256
      return (
        (r.u64() << BigInt(192)) |
        (r.u64() << BigInt(128)) |
        (r.u64() << BigInt(64)) |
        r.u64()
      );
    case 12: // SCV_I256
      return (
        (r.i64() << BigInt(192)) |
        (r.u64() << BigInt(128)) |
        (r.u64() << BigInt(64)) |
        r.u64()
      );
    case 13: // SCV_BYTES
      return r.varBytes();
    case 14: // SCV_STRING
    case 15: // SCV_SYMBOL
      return new TextDecoder().decode(r.varBytes());
    case 16: {
      // SCV_VEC (optional)
      if (r.u32() === 0) return undefined;
      const length = r.u32();
      return Array.from({ length }, () => readScVal(r));
    }
    case 17: {
      // SCV_MAP (optional)
      if (r.u32() === 0) return undefined;
      const length = r.u32();
      const out: { [key: string]: NativeScVal } = {};
      for (let i = 0; i < length; i += 1) {
        const key = readScVal(r);
        out[String(key)] = readScVal(r);
      }
      return out;
    }
    case 18: // SCV_ADDRESS
      return readAddress(r);
    default:
      throw new Error(`Unsupported ScVal type ${type}`);
  }
}

/**
 * Decode a base64 `ScVal` into plain JS values. Mirrors the SDK's
 * `scValToNative` for every type the attestation contract can return.
 */
export function decodeScVal(base64: string): NativeScVal {
  const reader = new XdrReader(Uint8Array.from(Buffer.from(base64, "base64")));
  const value = readScVal(reader);
  if (!reader.done()) throw new Error("Trailing bytes after ScVal");
  return value;
}
