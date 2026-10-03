# ADR-004: Encrypt cached emergency envelopes at rest

**Status:** Proposed — pending security review of the key derivation
**Date:** 2026-09-26
**Issue:** #630

## Context

ADR-003 stores a versioned emergency envelope per card in Cache Storage so a
responder can read the card offline. Those envelopes were plaintext JSON, and
the Cache Storage key was the raw card URL. Anyone with devtools or
file-system access to a shared or lost phone could read the patient's health
data and the capability link itself. Cache Storage has no access control
beyond the origin.

## Decision

Envelopes are encrypted in the service worker (`public/sw.js`, helpers in
`public/offline-cache-helpers.js`) with WebCrypto before `cache.put`, and
decrypted in `handleCardNavigation` when serving offline.

- **Key material.** The secret is the last path segment of the card URL:
  the 256-bit capability token for `/card/c/<token>`, or the card UUID for
  legacy `/card/<id>` links. Nothing else on the device holds it.
- **Key derivation.** HKDF-SHA-256 over the secret with a random 16-byte
  salt per envelope and `info = "lafiya-offline-envelope-v2"`, producing a
  non-extractable AES-256-GCM key.
- **Encryption.** AES-256-GCM with a random 12-byte IV per envelope. The
  opaque cache key is bound as additional authenticated data, so a
  ciphertext cannot be moved to another entry.
- **Cache key.** Entries are stored at
  `/__lafiya-offline-envelope/<hex SHA-256("lafiya-offline-cache-key-v2:" + path)>`,
  never under the raw URL, so the capability does not appear in Cache
  Storage. The hash is domain-separated from the key derivation, and the
  secret has at least 122 bits of entropy, so the hash cannot be reversed by
  guessing.
- **Stored record.** `{ version: 2, salt, iv, ciphertext }` (base64). Only
  the cache bookkeeping headers (cached-at time, last-accessed time, byte
  size) stay in clear text; they contain no PHI.
- **Integrity.** The existing SHA-256 envelope checksum is kept inside the
  ciphertext, and the GCM tag authenticates the record as a whole. A failed
  decryption (wrong link, tampering, a swapped entry) is treated as a
  corrupted envelope: the entry is deleted and the honest "no safe cached
  card" page is shown.

## Migration

The cache name moves from `lafiya-emergency-envelopes-v1` to
`lafiya-emergency-envelopes-v2`. The existing activation handler deletes
every other cache, so all v1 plaintext entries are evicted when the new
service worker activates. A v1 record read under v2 never decrypts, so it
also fails closed. v1 entries are not migrated: they would need the URL to
encrypt, and the card is re-cached on the next online visit.

## Consequences

- No plaintext PHI or capability is left in Cache Storage (covered by a unit
  test that inspects the raw cached bytes).
- Offline rendering still works from the same URL, because the URL carries
  the secret.
- Anyone who holds the link can still decrypt. That is out of scope: the
  link already grants access online.
- Cards opened once before this change must be reopened online to be
  available offline again.
- Measured decryption cost is about 0.2 ms median and 0.6 ms p95 (Node 24
  WebCrypto, container CPU, 200 runs on a worst-case envelope). This is well
  inside the 20 ms target, but it still needs confirming on a low-end
  Android device before this ADR is accepted.
