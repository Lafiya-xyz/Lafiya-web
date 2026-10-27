# Spike: NTAG 424 DNA SUN messages for clone-resistant card tags (#772)

## Summary

The NFC feature (`app/(auth)/profile/nfc-write-button.tsx`) writes a static
capability URL. NTAG 424 DNA tags can instead emit a **Secure Unique NFC (SUN)**
URL on every tap: encrypted PICCData (UID + 24-bit read counter) and a truncated
AES-CMAC. The prototype verifier lives in `lib/nfc/sun.ts` and is exposed at
`GET /api/nfc/sun?picc=<32 hex>&cmac=<16 hex>` (501 unless
`NFC_SUN_MASTER_KEY` is set). Tests (`lib/nfc/sun.test.ts`,
`app/api/nfc/sun/route.test.ts`) cover RFC 4493 CMAC vectors and rejection of
replayed, tampered and malformed messages.

## Prototype design

| Concern          | Prototype                                                                                                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key provisioning | One server master key. `SDMMetaRead` key = HMAC(master, "sdm-meta-read") (shared, needed to decrypt before the UID is known). `SDMFileRead` key = HMAC(master, "sdm-file-read" ‖ UID), diversified per tag, so extracting one tag's key does not forge others.                                 |
| Write format     | NDEF URL with SDM mirroring: `…/api/nfc/sun?picc={PICCData}&cmac={SDMMAC}`, SDM options: UID + counter mirror, encrypted PICCData, CMAC over empty input.                                                                                                                                      |
| MAC              | Session key = CMAC(FileReadKey, `3CC3 0001 0080` ‖ UID ‖ ctr LE), MAC = odd bytes of CMAC(session, ""). Per NXP AN12196.                                                                                                                                                                       |
| Replay           | Server keeps last accepted counter per UID; only a strictly greater counter is accepted (`SunCounterStore.advance`, compare-and-set). The spike uses a per-process store; production needs a `nfc_tag_counters(uid_hash, last_counter)` table updated with `update … where last_counter < $1`. |
| Revocation       | Server-side denylist keyed by UID hash; a revoked tag verifies cryptographically but resolves to no card.                                                                                                                                                                                      |

## Offline behaviour

SUN verification requires the server (keys never leave it). When the responder
is offline the tag URL cannot be verified and the responder sees the browser's
offline page, or the cached card if the PWA service worker already holds it.
Mitigation: keep the printed QR and the on-device offline card
(`lib/emergency/offline-source.tsx`) as the offline fallback; SUN is an
online authenticity signal, not an availability path.

## Browser support for writing

Web NFC (`NDEFReader`) is Chrome on Android only and can write NDEF records but
**cannot** issue the ISO 7816 `ChangeKey` / `ChangeFileSettings` APIs needed to
enable SDM and set keys. Tag personalisation therefore needs either a native
companion app or pre-personalised tags from the supplier. iOS cannot write via
the web at all.

## Cost and logistics

NTAG 424 DNA inlays/cards cost roughly 3–5× an NTAG 213/215 tag in volume.
Issuance requires a personalisation step (supplier or CHW-run Android app) with
key injection under the master key, plus a UID-to-card binding step recorded
server-side. Lost cards are revoked by UID.

## Threat analysis

| Threat                | Static URL (today)                              | SUN                                                                                | QR only                        |
| --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------ |
| Copy tag with a phone | Trivial, copy is indistinguishable              | Copy replays one stale counter; rejected after the genuine tag is tapped once more | Photo copy trivial             |
| Forge a new tag       | Needs a valid capability token                  | Needs per-tag AES key (not extractable from tag)                                   | Needs a valid capability token |
| Remote revocation     | Revoke the capability token (all media at once) | Per-tag UID denylist, plus token revocation                                        | Revoke capability token        |
| Eavesdrop a tap       | Leaks reusable URL                              | Leaks a one-time URL; replay rejected                                              | n/a                            |
| Works offline         | URL visible, card needs network                 | Needs network to verify                                                            | Same as static                 |
| Device support        | All NFC phones read                             | All NFC phones read; write needs native tooling                                    | Any camera                     |
| Cost                  | Lowest                                          | Highest                                                                            | Lowest (print)                 |

Residual SUN risk: a captured but never-replayed tap URL can be used once before
the genuine tag is next tapped. Keep capability TTLs and view limits in place.

## Recommendation and staged adoption

Adopt SUN as an **optional hardened tag**, not a replacement:

1. **Stage 0 (this spike):** verifier library, endpoint behind
   `NFC_SUN_MASTER_KEY`, tests.
2. **Stage 1:** persistent counter + revocation table, master key in the secret
   manager, verified tap redirects to the existing capability flow.
3. **Stage 2:** pilot with supplier-personalised tags for one CHW cohort;
   measure tap success rate and offline failures.
4. **Stage 3:** offer SUN tags as the default issued tag; keep static URL writes
   and QR for user-written tags and offline use.
