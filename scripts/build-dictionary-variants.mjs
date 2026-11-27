#!/usr/bin/env node
// Compression Dictionary Transport spike (Issue #879).
//
// Usage:
//   node scripts/build-dictionary-variants.mjs --prev <dir> --curr <dir> [--out <dir>]
//
// Pairs every .js/.css asset in --curr with the asset of the same logical name
// in --prev (content hashes stripped from file names) and reports the bytes a
// returning visitor would download as plain brotli vs. a `dcz` delta against
// the previous release (RFC 9842: zstd with the old asset as a raw
// dictionary). With --out it also writes `<asset>.dcz` files.
//
// Output is deterministic: inputs are sorted, compression levels are fixed and
// nothing time-dependent is embedded, so CI can reproduce identical variants.
// See docs/compression-dictionary-transport.md for the decision record.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { brotliCompressSync, constants, zstdCompressSync } from "node:zlib";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split("=", 2);
    if (flag.startsWith("--")) args[flag.slice(2)] = inline ?? argv[++i];
  }
  return args;
}

function listAssets(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?js|css)$/.test(name)) out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

// `chunks/app/page-3f2a9c1d0b7e.js` -> `chunks/app/page.js`
export function logicalName(path) {
  return path.replace(/[-.~][0-9a-f]{8,}(?=\.(m?js|css)$)/, "");
}

// RFC 9842 dcz framing: magic, then SHA-256 of the dictionary, then zstd.
const DCZ_MAGIC = Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0x00, 0x00, 0x00]);

export function encodeDcz(content, dictionary) {
  const hash = createHash("sha256").update(dictionary).digest();
  const body = zstdCompressSync(content, {
    dictionary,
    params: { [constants.ZSTD_c_compressionLevel]: 19 },
  });
  return Buffer.concat([DCZ_MAGIC, hash, body]);
}

function brotli(content) {
  return brotliCompressSync(content, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prev || !args.curr) {
    console.error("Usage: --prev <dir> --curr <dir> [--out <dir>]");
    process.exit(2);
  }

  const previous = new Map(
    listAssets(args.prev).map((path) => [
      logicalName(path),
      join(args.prev, path),
    ]),
  );

  let totalBrotli = 0;
  let totalDelivered = 0;
  const rows = [];
  for (const path of listAssets(args.curr)) {
    const content = readFileSync(join(args.curr, path));
    const br = brotli(content).length;
    const prevPath = previous.get(logicalName(path));
    let dcz = null;
    if (prevPath) {
      const encoded = encodeDcz(content, readFileSync(prevPath));
      dcz = encoded.length;
      if (args.out) {
        const target = join(args.out, `${path}.dcz`);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, encoded);
      }
    }
    totalBrotli += br;
    totalDelivered += dcz !== null ? Math.min(dcz, br) : br;
    rows.push({ path, raw: content.length, br, dcz });
  }

  for (const row of rows) {
    console.log(
      `${row.path}\traw=${row.raw}\tbr=${row.br}\tdcz=${row.dcz ?? "-"}`,
    );
  }
  const saved = totalBrotli ? (1 - totalDelivered / totalBrotli) * 100 : 0;
  console.log(
    `\nTotal brotli=${totalBrotli} B, with dictionaries=${totalDelivered} B (${saved.toFixed(1)}% saved)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
