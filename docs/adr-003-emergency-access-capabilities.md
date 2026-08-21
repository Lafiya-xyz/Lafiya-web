# ADR-003: Bounded emergency capabilities and offline envelopes

**Status:** Accepted
**Date:** 2026-08-21

## Decision

Lafiya now has two public emergency-access paths during a measured migration:

1. Existing `/card/<uuid>` links remain available only until each profile's
   `legacy_card_sunset_at` (180 days after this migration). The public lookup
   enforces that date, so legacy bearer links cannot silently become permanent.
2. Newly issued `/card/c/<capability>` links carry a versioned, 256-bit random
   capability. Lafiya persists only its SHA-256 digest. An emergency capability
   expires within 180 days; a temporary capability expires within 30 days and
   has an atomic view budget of 1–20 views.

Capability resolution locks its row and increments the view count in the same
transaction that authorizes disclosure. Revoked, expired, exhausted,
malformed, and unknown capabilities return the same no-data public result.
The capability never includes a user ID, revision ID, commitment, record hash,
or other enumerable identifier.

The public page is dynamic and sends `Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer`, a restrictive card-route CSP, and no-index
directives. The service worker deliberately ignores rendered HTML as durable
data. It extracts the server-provided emergency projection into an envelope
with a schema version, record-update time, authorization expiry, verification
snapshot, cache time, and SHA-256 checksum. It renders an unhydrated,
self-contained offline document from that envelope.

## Freshness and offline policy

The UI and offline view keep these values separate:

| Signal                                           | Meaning                                                                                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Record updated                                   | Time the published record revision was created.                                                    |
| Authorization valid until / cached authorization | Time the capability or legacy migration authorization expires; offline cannot re-check revocation. |
| Verification last checked                        | Time the persisted trust decision was last updated.                                                |
| Cached on                                        | Time this browser stored its envelope.                                                             |

The cache retains at most 60 entries / 3 MiB and has a hard **72-hour** offline
age ceiling. Unsupported, oversized, malformed, tampered, expired, or
authorization-expired envelopes fail closed and delete only that entry. A
valid offline card visibly says that current authorization and revocation
cannot be checked. When any card route next reaches the network, cache
admission refreshes the envelope; consent withdrawal, a revoked/expired
capability, or an unavailable response removes the old local entry.

## Consequences and limitations

A browser that stays permanently offline cannot learn a subsequent revocation,
rotation, edit, or consent withdrawal. Neither Lafiya nor any web application
can remotely delete a screenshot, printed QR, browser cache controlled by an
offline device, or copied data. The 72-hour envelope window bounds Lafiya's
own offline presentation and makes this limitation explicit; it is not a claim
of remote deletion. The checksum detects accidental cache corruption, not a
malicious browser/origin compromise that can replace both data and checksum.

Critical text remains server-rendered without client hydration, fonts,
analytics, Stellar RPC, or a profile image. A verification-provider failure is
rendered as a distinct unavailable state and never hides emergency facts.

## Accountability and retention

Successful card resolutions schedule a post-response access event with
Next.js `after()`. This work cannot delay the emergency response. Events store
only owner, capability surrogate (when applicable), coarse path/outcome, and
time—never the raw capability, IP address, user agent, health values, user ID
in public output, revision, or record hash. The write path removes events
older than 90 days before inserting. Patients may view only their 30-day
aggregate through RLS and a narrow summary function.

## Rollout and migration

1. Apply the additive migration before deploying this application version.
2. Existing UUID cards continue until `legacy_card_sunset_at`; profile UI
   labels the deadline and offers a current emergency QR.
3. In pilot support, ask patients to issue and reprint a capability QR before
   their legacy deadline. Do not invalidate printed cards without this notice.
4. Track aggregate legacy access through the 90-day access summary. A later
   migration may remove the UUID path only after pilot/clinical approval and
   documented migration completion.

The protocol is local to `lafiya-web`; it does not change the Soroban
attestation schema or put patient/capability material on Stellar.
