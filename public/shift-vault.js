// Issue #873: responder shift vault.
//
// During a declared shift (max 12 h, max 20 cards), offline envelopes the
// service worker produces for scanned cards are kept in an IndexedDB vault,
// AES-GCM encrypted under a non-extractable WebCrypto key. Ending the shift
// (or noticing on the next service-worker activation / page load that it has
// expired) deletes the key together with every entry: crypto-wipe.
//
// Only envelopes produced by createOfflineEnvelope() are vaulted, and that
// function returns null unless the patient allowed offline caching, so cards
// without offline consent are never vaulted.
//
// Shared by public/sw.js and the /scan page (allowJs).

export const SHIFT_MAX_MS = 12 * 60 * 60 * 1000;
export const SHIFT_MAX_CARDS = 20;
export const VAULT_DB = "lafiya-shift-vault";

const META = "meta";
const ENTRIES = "entries";
const AUDIT = "audit";

/** In-memory store used by tests; mirrors the IndexedDB adapter API. */
export function memoryVaultStore() {
  const data = { [META]: new Map(), [ENTRIES]: new Map(), [AUDIT]: new Map() };
  return {
    async get(store, key) {
      return data[store].get(key);
    },
    async put(store, key, value) {
      data[store].set(key, value);
    },
    async delete(store, key) {
      data[store].delete(key);
    },
    async values(store) {
      return [...data[store].values()];
    },
    async clear(store) {
      data[store].clear();
    },
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB adapter. */
export function openVaultStore(idb = globalThis.indexedDB) {
  let dbPromise = null;
  const db = () => {
    if (!dbPromise) {
      const open = idb.open(VAULT_DB, 1);
      open.onupgradeneeded = () => {
        for (const name of [META, ENTRIES, AUDIT]) {
          if (!open.result.objectStoreNames.contains(name)) {
            open.result.createObjectStore(name);
          }
        }
      };
      dbPromise = request(open);
    }
    return dbPromise;
  };
  const tx = async (store, mode, fn) => {
    const handle = await db();
    return request(fn(handle.transaction(store, mode).objectStore(store)));
  };
  return {
    get: (store, key) => tx(store, "readonly", (s) => s.get(key)),
    put: (store, key, value) =>
      tx(store, "readwrite", (s) => s.put(value, key)),
    delete: (store, key) => tx(store, "readwrite", (s) => s.delete(key)),
    values: (store) => tx(store, "readonly", (s) => s.getAll()),
    clear: (store) => tx(store, "readwrite", (s) => s.clear()),
  };
}

export async function getShift(store) {
  return (await store.get(META, "shift")) ?? null;
}

export function isShiftActive(shift, now = Date.now()) {
  return !!shift && now < shift.endsAt;
}

export async function startShift(store, options = {}) {
  const now = options.now ?? Date.now();
  const durationMs = Math.min(options.durationMs ?? SHIFT_MAX_MS, SHIFT_MAX_MS);
  await endShift(store);
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
  const shift = {
    startedAt: now,
    endsAt: now + durationMs,
    key,
    credentialId: options.credentialId ?? null,
  };
  await store.put(META, "shift", shift);
  return shift;
}

/**
 * Crypto-wipe: deletes the key and every vaulted entry. Coarse audit buckets
 * (no card data) are kept until they are sent.
 */
export async function endShift(store) {
  await store.clear(META);
  await store.clear(ENTRIES);
}

export async function wipeIfExpired(store, now = Date.now()) {
  const shift = await getShift(store).catch(() => null);
  if (shift && !isShiftActive(shift, now)) {
    await endShift(store);
    return true;
  }
  return false;
}

/**
 * Vaults an offline envelope. Returns false when there is no active shift,
 * the envelope lacks offline consent, or the vault is full.
 */
export async function vaultCard(store, { path, envelope }, now = Date.now()) {
  if (await wipeIfExpired(store, now)) return false;
  const shift = await getShift(store);
  if (!isShiftActive(shift, now)) return false;
  if (!envelope || envelope.offlineAllowed === false) return false;

  const entries = await store.values(ENTRIES);
  let id = null;
  for (const entry of entries) {
    const existing = await decryptEntry(shift.key, entry).catch(() => null);
    if (existing && existing.path === path) id = entry.id;
  }
  if (!id && entries.length >= SHIFT_MAX_CARDS) return false;
  id = id ?? crypto.randomUUID();

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ path, envelope }),
  );
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    shift.key,
    plaintext,
  );
  await store.put(ENTRIES, id, { id, scannedAt: now, iv, data });
  // Coarse, privacy-safe audit: hour bucket only, no card identifiers.
  const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString();
  const bucket = (await store.get(AUDIT, hour)) ?? { hour, count: 0 };
  await store.put(AUDIT, hour, { hour, count: bucket.count + 1 });
  return true;
}

async function decryptEntry(key, entry) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: entry.iv },
    key,
    entry.data,
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function listVault(store, now = Date.now()) {
  if (await wipeIfExpired(store, now)) return [];
  const entries = await store.values(ENTRIES);
  return entries
    .map(({ id, scannedAt }) => ({ id, scannedAt }))
    .sort((a, b) => b.scannedAt - a.scannedAt);
}

/** Decrypts one entry; null after the shift ended (key destroyed). */
export async function openVaultEntry(store, id, now = Date.now()) {
  if (await wipeIfExpired(store, now)) return null;
  const shift = await getShift(store);
  const entry = await store.get(ENTRIES, id);
  if (!isShiftActive(shift, now) || !entry) return null;
  return decryptEntry(shift.key, entry).catch(() => null);
}

/** Sends queued coarse audit buckets; kept queued when offline. */
export async function flushVaultAudit(store, fetchImpl = fetch) {
  const buckets = await store.values(AUDIT);
  if (buckets.length === 0) return 0;
  const response = await fetchImpl("/api/scan/vault-audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: buckets }),
  }).catch(() => null);
  if (!response || !response.ok) return 0;
  for (const bucket of buckets) await store.delete(AUDIT, bucket.hour);
  return buckets.length;
}
