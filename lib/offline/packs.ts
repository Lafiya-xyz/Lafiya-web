/**
 * Issue #876: large offline packs (facility directory, fonts, translations).
 *
 * A pack is one file split into byte-range chunks, each with a SHA-256. The
 * manifest is signed (ECDSA P-256 / SHA-256 over the canonical manifest
 * body) and verified on the page before any download starts.
 *
 * Downloads use Background Fetch when available so they survive tab close;
 * otherwise chunks are fetched with Range requests, and chunks already
 * verified in the cache are skipped so an interrupted download resumes.
 *
 * Chunks are staged in a version-specific cache. Readers resolve the active
 * version through a pointer entry that is flipped only after every chunk has
 * been verified, so a pack is swapped atomically (never half-updated).
 * `public/sw.js` mirrors `verifyChunk`/`commitPack` for Background Fetch.
 */

export type PackChunk = { offset: number; length: number; sha256: string };

export type PackManifest = {
  name: string;
  version: string;
  url: string;
  size: number;
  chunks: PackChunk[];
  /** Base64 ECDSA P-256 signature over `canonicalManifest(manifest)`. */
  signature: string;
};

export const PACK_POINTER_CACHE = "lafiya-packs";
export const PACK_CACHE_PREFIX = "lafiya-pack-";
export const PACK_MANIFEST_PATH = "/__lafiya-pack-manifest/";
export const PACK_POINTER_PATH = "/__lafiya-pack-current/";
export const MAX_CHUNK_ATTEMPTS = 3;

export const packCacheName = (m: Pick<PackManifest, "name" | "version">) =>
  `${PACK_CACHE_PREFIX}${m.name}-${m.version}`;
export const chunkKey = (m: PackManifest, index: number) =>
  `${m.url}#chunk=${index}`;
export const backgroundFetchId = (m: PackManifest) =>
  `pack:${m.name}@${m.version}`;

export function canonicalManifest(m: PackManifest): string {
  return JSON.stringify({
    name: m.name,
    version: m.version,
    url: m.url,
    size: m.size,
    chunks: m.chunks.map((c) => [c.offset, c.length, c.sha256]),
  });
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function verifyManifestSignature(
  manifest: PackManifest,
  publicKey: JsonWebKey,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64(manifest.signature),
      new TextEncoder().encode(canonicalManifest(manifest)),
    );
  } catch {
    return false;
  }
}

/** Structural checks: chunks are contiguous and cover exactly `size` bytes. */
export function isWellFormedManifest(m: PackManifest): boolean {
  let expected = 0;
  for (const c of m.chunks) {
    if (c.offset !== expected || c.length <= 0) return false;
    if (!/^[0-9a-f]{64}$/.test(c.sha256)) return false;
    expected += c.length;
  }
  return m.chunks.length > 0 && expected === m.size;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifyChunk(
  chunk: PackChunk,
  data: ArrayBuffer,
): Promise<boolean> {
  return (
    data.byteLength === chunk.length && (await sha256Hex(data)) === chunk.sha256
  );
}

export function chunkRequest(m: PackManifest, index: number): Request {
  const c = m.chunks[index];
  return new Request(m.url, {
    headers: { Range: `bytes=${c.offset}-${c.offset + c.length - 1}` },
  });
}

/** Indexes of chunks not yet staged (resume point). */
export async function missingChunks(m: PackManifest): Promise<number[]> {
  const cache = await caches.open(packCacheName(m));
  const missing: number[] = [];
  for (let i = 0; i < m.chunks.length; i++) {
    if (!(await cache.match(chunkKey(m, i)))) missing.push(i);
  }
  return missing;
}

/** Flips the pointer to `m.version` once every chunk is staged. */
export async function commitPack(m: PackManifest): Promise<boolean> {
  if ((await missingChunks(m)).length > 0) return false;
  const pointers = await caches.open(PACK_POINTER_CACHE);
  await pointers.put(
    PACK_POINTER_PATH + m.name,
    Response.json({ version: m.version, manifest: m }),
  );
  for (const key of await caches.keys()) {
    if (
      key.startsWith(`${PACK_CACHE_PREFIX}${m.name}-`) &&
      key !== packCacheName(m)
    ) {
      await caches.delete(key);
    }
  }
  return true;
}

export async function activePackVersion(name: string): Promise<string | null> {
  const pointers = await caches.open(PACK_POINTER_CACHE);
  const hit = await pointers.match(PACK_POINTER_PATH + name);
  if (!hit) return null;
  const body = (await hit.json().catch(() => null)) as {
    version?: string;
  } | null;
  return body?.version ?? null;
}

/** Reassembled bytes of the active version of a pack, or null. */
export async function readActivePack(
  name: string,
): Promise<ArrayBuffer | null> {
  if (typeof caches === "undefined") return null;
  const pointers = await caches.open(PACK_POINTER_CACHE);
  const hit = await pointers.match(PACK_POINTER_PATH + name);
  const body = hit
    ? ((await hit.json().catch(() => null)) as {
        manifest?: PackManifest;
      } | null)
    : null;
  const manifest = body?.manifest;
  if (!manifest) return null;
  const cache = await caches.open(packCacheName(manifest));
  const out = new Uint8Array(manifest.size);
  for (let i = 0; i < manifest.chunks.length; i++) {
    const hit = await cache.match(chunkKey(manifest, i));
    if (!hit) return null;
    out.set(new Uint8Array(await hit.arrayBuffer()), manifest.chunks[i].offset);
  }
  return out.buffer;
}

export type PackProgress = { done: number; total: number };

/** Range-request fallback; verified chunks are staged and skipped on resume. */
export async function downloadPackResumable(
  m: PackManifest,
  onProgress?: (p: PackProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const cache = await caches.open(packCacheName(m));
  const missing = await missingChunks(m);
  let done = m.chunks.length - missing.length;
  onProgress?.({ done, total: m.chunks.length });
  for (const index of missing) {
    let ok = false;
    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS && !ok; attempt++) {
      try {
        const response = await fetchImpl(chunkRequest(m, index));
        if (response.status !== 206 && response.status !== 200) continue;
        let data = await response.arrayBuffer();
        if (response.status === 200) {
          const c = m.chunks[index];
          data = data.slice(c.offset, c.offset + c.length);
        }
        // Corrupted chunks are rejected and retried.
        if (!(await verifyChunk(m.chunks[index], data))) continue;
        await cache.put(chunkKey(m, index), new Response(data));
        ok = true;
      } catch {
        // Network error: retry, then leave the chunk for a later resume.
      }
    }
    if (!ok) return false;
    onProgress?.({ done: ++done, total: m.chunks.length });
  }
  return commitPack(m);
}

type BackgroundFetchManager = {
  fetch: (
    id: string,
    requests: Request[],
    options: { title: string; downloadTotal: number },
  ) => Promise<unknown>;
};

export function prefersSaveData(): boolean {
  const connection = (
    navigator as Navigator & { connection?: { saveData?: boolean } }
  ).connection;
  return connection?.saveData === true;
}

/**
 * Starts a pack download. Uses Background Fetch when supported (the service
 * worker verifies and commits on `backgroundfetchsuccess`), otherwise the
 * resumable fallback. Returns "background" | "complete" | "failed".
 */
export async function startPackDownload(
  m: PackManifest,
  publicKey: JsonWebKey,
  onProgress?: (p: PackProgress) => void,
): Promise<"background" | "complete" | "failed"> {
  if (
    !isWellFormedManifest(m) ||
    !(await verifyManifestSignature(m, publicKey))
  ) {
    return "failed";
  }
  // The service worker reads the verified manifest from here, so the
  // download can complete after the tab is closed.
  const pointers = await caches.open(PACK_POINTER_CACHE);
  await pointers.put(
    PACK_MANIFEST_PATH + backgroundFetchId(m),
    Response.json(m),
  );

  const registration = await navigator.serviceWorker?.ready;
  const backgroundFetch = (
    registration as
      | (ServiceWorkerRegistration & {
          backgroundFetch?: BackgroundFetchManager;
        })
      | undefined
  )?.backgroundFetch;
  const missing = await missingChunks(m);
  if (backgroundFetch && missing.length > 0) {
    try {
      await backgroundFetch.fetch(
        backgroundFetchId(m),
        missing.map((i) => chunkRequest(m, i)),
        { title: `Lafiya offline pack: ${m.name}`, downloadTotal: m.size },
      );
      return "background";
    } catch {
      // Fall through to the resumable fallback.
    }
  }
  return (await downloadPackResumable(m, onProgress)) ? "complete" : "failed";
}
