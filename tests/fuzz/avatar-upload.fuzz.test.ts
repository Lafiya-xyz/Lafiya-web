// @vitest-environment node
/**
 * Issue #784: seeded mutation fuzzer for the avatar upload pipeline
 * (app/api/profile/photo/route.ts).
 *
 * Seeds are tiny PNG/JPEG/WebP/GIF images generated at start-up; each run
 * mutates them (bit flips, interesting-byte overwrites, truncation, chunk
 * splicing, header dimension corruption) and posts the result through the
 * real route with every declared content type. A curated corpus of
 * known-bad inputs (polyglots, decompression bombs, EXIF bombs,
 * zero-dimension headers) runs first.
 *
 * Asserts, per input: bounded wall time, no exception reaching the route's
 * catch-all (logError) or escaping POST, and a 4xx body drawn only from the
 * route's fixed rejection messages (no decoder internals leak). Across the
 * run: RSS growth stays below a ceiling.
 *
 * Reproduce a failure with AVATAR_FUZZ_SEED=<seed> (printed on failure);
 * any crash or hang found should be added to KNOWN_BAD below as a
 * regression case.
 */
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/profile/photo/route";
import { logError } from "@/lib/logging/logger";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logging/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/storage/avatar", () => ({
  getAvatarSignedUrl: vi.fn(async (p: string) => `https://signed.test/${p}`),
}));
// No frequency cap here: the fuzzer is about decoding, not throttling.
vi.mock("@/lib/frequency-limit", () => ({
  checkAndIncrementFrequency: vi.fn(async () => ({
    allowed: true,
    count: 1,
    retryAfterSeconds: 0,
  })),
}));

const RUNS = Number(process.env.AVATAR_FUZZ_RUNS ?? 5000);
const SEED = Number(process.env.AVATAR_FUZZ_SEED ?? 784);
const PER_INPUT_BUDGET_MS = 5_000;
const RSS_GROWTH_CEILING_BYTES = 256 * 1024 * 1024;
const DECLARED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const REJECTION_MESSAGES = new Set([
  "No file provided",
  "Invalid file type",
  "Photo must be under 5 MB.",
  "Photo dimensions are too large to process.",
  "Invalid image data",
  "File content does not match declared type",
  "Invalid or corrupted image data",
]);
const INTERESTING_BYTES = [0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff];

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T>(rand: Rand, items: readonly T[]) =>
  items[Math.floor(rand() * items.length)]!;
const int = (rand: Rand, max: number) => Math.floor(rand() * max);

function mutate(rand: Rand, seed: Buffer): Buffer {
  let out = Buffer.from(seed);
  const rounds = 1 + int(rand, 4);
  for (let i = 0; i < rounds && out.length > 0; i++) {
    switch (int(rand, 6)) {
      case 0: // bit flip
        out[int(rand, out.length)] ^= 1 << int(rand, 8);
        break;
      case 1: // interesting byte
        out[int(rand, out.length)] = pick(rand, INTERESTING_BYTES);
        break;
      case 2: // truncate
        out = out.subarray(0, int(rand, out.length));
        break;
      case 3: {
        // duplicate a chunk in place
        const start = int(rand, out.length);
        const chunk = out.subarray(start, start + 1 + int(rand, 64));
        out = Buffer.concat([
          out.subarray(0, start),
          chunk,
          out.subarray(start),
        ]);
        break;
      }
      case 4: {
        // insert random bytes
        const at = int(rand, out.length);
        const junk = Buffer.from(
          Array.from({ length: 1 + int(rand, 32) }, () => int(rand, 256)),
        );
        out = Buffer.concat([out.subarray(0, at), junk, out.subarray(at)]);
        break;
      }
      case 5: {
        // corrupt a 32-bit field near the header (dimension fields live here)
        if (out.length >= 32)
          out.writeUInt32BE(int(rand, 2 ** 32), int(rand, 28));
        break;
      }
    }
  }
  return out;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function pngWithDimensions(
  width: number,
  height: number,
  idat: Buffer,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegWithExifBomb(jpeg: Buffer): Buffer {
  // Many maximal APP1 (EXIF) segments right after SOI.
  const payload = Buffer.alloc(65_533, 0x41);
  payload.write("Exif\0\0", 0, "binary");
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xe1, 0xff, 0xff]),
    payload,
  ]);
  return Buffer.concat([
    jpeg.subarray(0, 2),
    ...Array.from({ length: 60 }, () => segment),
    jpeg.subarray(2),
  ]);
}

let seeds: { type: string; buffer: Buffer }[] = [];
// `accept: true` marks inputs that are hostile in shape but within budget
// (they must still be handled in bounded time and memory). Accepted inputs
// are always re-encoded from pixels, so appended polyglot payloads and EXIF
// never reach storage.
let knownBad: {
  name: string;
  type: string;
  buffer: Buffer;
  accept?: boolean;
}[] = [];

beforeAll(async () => {
  sharp.cache(false);
  const base = sharp({
    create: { width: 24, height: 16, channels: 3, background: "#3a7" },
  });
  const [png, jpeg, webp, gif] = await Promise.all([
    base.clone().png().toBuffer(),
    base.clone().jpeg().toBuffer(),
    base.clone().webp().toBuffer(),
    base.clone().gif().toBuffer(),
  ]);
  seeds = [
    { type: "image/png", buffer: png },
    { type: "image/jpeg", buffer: jpeg },
    { type: "image/webp", buffer: webp },
    { type: "image/gif", buffer: gif },
  ];

  const fixture = (name: string) =>
    fs.readFileSync(path.resolve(__dirname, "..", "fixtures", name));
  knownBad = [
    {
      name: "zero-width PNG",
      type: "image/png",
      buffer: pngWithDimensions(0, 10, deflateSync(Buffer.alloc(10))),
    },
    {
      name: "zero-height PNG",
      type: "image/png",
      buffer: pngWithDimensions(10, 0, deflateSync(Buffer.alloc(10))),
    },
    {
      name: "declared 2^31 PNG",
      type: "image/png",
      buffer: pngWithDimensions(
        0x7fffffff,
        0x7fffffff,
        deflateSync(Buffer.alloc(16)),
      ),
    },
    {
      name: "zlib bomb PNG (4000x4000 of zeros)",
      type: "image/png",
      buffer: pngWithDimensions(
        4000,
        4000,
        deflateSync(Buffer.alloc(4001 * 4000)),
      ),
      accept: true,
    },
    {
      name: "fixture bomb-declared-only",
      type: "image/png",
      buffer: fixture("bomb-declared-only.png"),
    },
    {
      name: "fixture bomb-lied-header",
      type: "image/png",
      buffer: fixture("bomb-lied-header.png"),
    },
    {
      name: "fixture bomb-oversized jpeg",
      type: "image/jpeg",
      buffer: fixture("bomb-oversized.jpg"),
    },
    {
      name: "fixture bomb-oversized webp",
      type: "image/webp",
      buffer: fixture("bomb-oversized.webp"),
    },
    {
      name: "EXIF bomb JPEG",
      type: "image/jpeg",
      buffer: jpegWithExifBomb(jpeg),
      accept: true,
    },
    {
      name: "GIF/HTML polyglot declared PNG",
      type: "image/png",
      buffer: Buffer.concat([gif, Buffer.from("<script>alert(1)</script>")]),
    },
    { name: "GIF declared as GIF", type: "image/gif", buffer: gif },
    {
      name: "JPEG+ZIP polyglot",
      type: "image/jpeg",
      buffer: Buffer.concat([
        jpeg,
        Buffer.from("PK\x03\x04", "binary"),
        Buffer.alloc(64),
      ]),
      accept: true,
    },
    { name: "PNG declared as JPEG", type: "image/jpeg", buffer: png },
    {
      name: "SVG declared as PNG",
      type: "image/png",
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      ),
    },
    { name: "empty file", type: "image/png", buffer: Buffer.alloc(0) },
    {
      name: "magic bytes only",
      type: "image/webp",
      buffer: Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "binary"),
    },
    {
      name: "truncated JPEG",
      type: "image/jpeg",
      buffer: jpeg.subarray(0, jpeg.length >> 1),
    },
  ];

  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "fuzz-user" } },
        error: null,
      }),
    },
    storage: {
      from: vi.fn().mockReturnValue({
        upload: vi.fn().mockResolvedValue({ error: null }),
        remove: vi.fn().mockResolvedValue({ error: null }),
      }),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>);
});

function uploadRequest(buffer: Buffer, type: string): Request {
  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(buffer)], { type }), "f");
  return new Request("http://localhost/api/profile/photo", {
    method: "POST",
    body: formData,
  });
}

async function exercise(buffer: Buffer, type: string, context: string) {
  vi.mocked(logError).mockClear();
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const response = await Promise.race([
    POST(uploadRequest(buffer, type)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`timeout after ${PER_INPUT_BUDGET_MS}ms: ${context}`),
          ),
        PER_INPUT_BUDGET_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  const elapsed = performance.now() - started;

  expect(elapsed, context).toBeLessThan(PER_INPUT_BUDGET_MS);
  expect(
    vi.mocked(logError),
    `unhandled exception: ${context}`,
  ).not.toHaveBeenCalled();
  expect([200, 400], context).toContain(response.status);
  if (response.status === 400) {
    const body = (await response.json()) as { error: string };
    expect(
      REJECTION_MESSAGES.has(body.error),
      `${context}: ${body.error}`,
    ).toBe(true);
  }
  return response.status;
}

describe("avatar upload fuzzing", () => {
  it("rejects every curated known-bad input uniformly and within budget", async () => {
    for (const bad of knownBad) {
      const status = await exercise(bad.buffer, bad.type, bad.name);
      expect(status, bad.name).toBe(bad.accept ? 200 : 400);
    }
  }, 120_000);

  it(`survives ${RUNS} seeded mutations within time and memory budgets`, async () => {
    const rand = prng(SEED);
    const statuses = { 200: 0, 400: 0 } as Record<number, number>;
    // Warm up decoders before taking the memory baseline.
    for (const seed of seeds) await exercise(seed.buffer, seed.type, "warm-up");
    const baselineRss = process.memoryUsage().rss;

    for (let run = 0; run < RUNS; run++) {
      const seed = pick(rand, seeds);
      const declared = rand() < 0.8 ? seed.type : pick(rand, DECLARED_TYPES);
      const input = mutate(rand, seed.buffer);
      const context = `seed=${SEED} run=${run} base=${seed.type} declared=${declared}`;
      const status = await exercise(input, declared, context);
      statuses[status] = (statuses[status] ?? 0) + 1;
    }

    const growth = process.memoryUsage().rss - baselineRss;
    expect(growth).toBeLessThan(RSS_GROWTH_CEILING_BYTES);
    // Sanity: the mutator must produce both accepted and rejected inputs,
    // otherwise it is not exercising the decoder at all.
    expect(statuses[200]).toBeGreaterThan(0);
    expect(statuses[400]).toBeGreaterThan(0);
  }, 900_000);
});

describe("fuzzer regressions", () => {
  // Found by this fuzzer: every decodable upload reached the catch-all with
  // `ReferenceError: path is not defined` because the stored path variable
  // had been lost in a merge, so the route returned 500 for valid photos.
  it("accepts a valid seed image without reaching the catch-all", async () => {
    for (const seed of seeds.filter((s) => s.type !== "image/gif")) {
      expect(
        await exercise(seed.buffer, seed.type, `regression ${seed.type}`),
      ).toBe(200);
    }
  });

  // Found by this fuzzer (truncation to zero bytes): sharp() throws
  // synchronously on an empty buffer, outside the decode try/catch.
  it("rejects a zero-byte upload of every declared type with a 400", async () => {
    for (const type of DECLARED_TYPES) {
      expect(await exercise(Buffer.alloc(0), type, `empty ${type}`)).toBe(400);
    }
  });
});
