# Apple/Google Wallet passes for the emergency card

Tracks issue [#538](https://github.com/Lafiya-xyz/Lafiya-web/issues/538): an
"Add to Wallet" pass that puts the emergency QR code on the lock screen, so a
responder can scan it without unlocking the phone or opening the Lafiya app.

## Status

**Not yet functional in any deployment.** The pass-content module and API
routes are implemented and unit-tested; the two things that require real,
secret credentials — signing an Apple `.pkpass` and signing a Google Wallet
save JWT — are stubbed and throw a clear error. No certificate, private key,
or service-account JSON was fabricated for this change; see
[Contributor Notes](#contributor-notes) below for why.

| Piece | Status |
|---|---|
| Pass content model (`lib/wallet-passes/passContent.ts`) | Done, unit-tested |
| Env var validation / fail-closed config (`lib/wallet-passes/config.ts`) | Done, unit-tested |
| `POST /api/wallet/apple` (returns `.pkpass`) | Done — 501s until signing is wired up |
| `POST /api/wallet/google` (returns a save link) | Done — 501s until signing is wired up |
| Apple `.pkpass` signing (`lib/wallet-passes/apple.ts`) | **Stub** — needs `passkit-generator` + a real cert |
| Google Wallet JWT signing (`lib/wallet-passes/google.ts`) | **Stub** — needs `jsonwebtoken` + a real service account |
| Pass update/voiding on card rotation (AC 2) | **Not started** — depends on signing existing first |
| Security review of key storage | **Not started** — see issue #538 |

## What's in a Lafiya wallet pass

Per the issue's design constraint, a pass is cached on the holder's device,
outside our control and outside Supabase RLS. It contains **only**:

- Lafiya branding (`organizationName: "Lafiya"`)
- A fixed label, `"Medical information: scan"`
- A QR/barcode encoding the capability-share URL
  (`https://.../card/c/<token>`) — the same non-PHI link the existing QR
  code panel already generates

It never contains a name, blood group, allergy, medication, or any other
field from `EMERGENCY_FIELD_ALLOWLIST`
(`lib/emergency/capability.ts`). Scanning the pass re-resolves the
capability through `/card/c/[token]`, which re-checks expiry/revocation/view
budget on every access — exactly like scanning the printed QR code.

`lib/wallet-passes/passContent.test.ts` asserts structurally that neither
platform's payload can contain PHI field names/values, and pins the exact
shape of `WalletPassContent` so a future edit can't silently widen it.

## Credentials required to make this functional

None of these exist in this repo or in the environment this change was
written in. Set them (and only then flip signing on — see
`lib/wallet-passes/apple.ts` / `google.ts` for exactly what's left to wire
up) once they're available:

### Apple Wallet

| Env var | What it is | How to get it |
|---|---|---|
| `APPLE_WALLET_SIGNER_CERT_BASE64` | Base64 of the Pass Type ID certificate (PEM) issued by the Apple Developer portal | Apple Developer > Certificates, Identifiers & Profiles > Pass Type IDs |
| `APPLE_WALLET_SIGNER_KEY_BASE64` | Base64 of the private key (PEM) matching that certificate | Exported at the same time as the certificate (keep offline/in a secret manager, never in git) |
| `APPLE_WALLET_SIGNER_KEY_PASSPHRASE` | Passphrase for the private key, if encrypted | Set when the key was generated |
| `APPLE_WALLET_WWDR_CERT_BASE64` | Base64 of Apple's current WWDR intermediate certificate (PEM) | https://www.apple.com/certificateauthority/ |
| `APPLE_WALLET_PASS_TYPE_IDENTIFIER` | e.g. `pass.xyz.lafiya.emergency` | Registered alongside the Pass Type ID certificate |
| `APPLE_WALLET_TEAM_IDENTIFIER` | Apple Developer Team ID | Apple Developer > Membership |

### Google Wallet

| Env var | What it is | How to get it |
|---|---|---|
| `GOOGLE_WALLET_SERVICE_ACCOUNT_JSON` | Full service-account key JSON (single-line/minified) | Google Cloud Console > IAM > Service Accounts, granted access in the Google Wallet API business console |
| `GOOGLE_WALLET_ISSUER_ID` | Google Wallet issuer account ID | Google Wallet API business console |
| `GOOGLE_WALLET_CLASS_ID` | ID of a generic pass class created once via the Google Wallet API | Created via a one-time setup call to the Wallet Objects API |

All of these are read via `lib/wallet-passes/config.ts`, which is the single
place that validates them — see `lib/runtime-config.ts` for why server
config is centralized this way in this codebase. If any required variable
for a platform is missing, `getAppleWalletConfig()` /
`getGoogleWalletConfig()` throws `WalletPassesNotConfiguredError`, and both
API routes turn that into an HTTP 501 with a message pointing back to this
file — never a silently-issued fake or unsigned pass.

## Why the signing step is a stub, not a fake implementation

This change was written in an environment with no Apple pass-signing
certificate and no Google Wallet service account, and the instructions for
this change were explicit: don't fabricate credentials. `passkit-generator`
and `jsonwebtoken` are listed as dependencies (not installed here) because
they're the intended libraries for the actual signing step — see the doc
comments in `lib/wallet-passes/apple.ts` and `lib/wallet-passes/google.ts`
for exactly what call to make once real credentials exist.

## Remaining work (out of scope for this change)

- Wire up real Apple/Google signing once credentials exist (see stubs above).
- Pass updates/voiding on card rotation (AC 2): Apple's web service push
  endpoints, and the Google Wallet update API. Needs a persisted mapping of
  capability → registered device(s)/pass, which doesn't exist yet.
- Security review of key storage (explicitly called out in the issue) before
  any real credential is ever set in a deployed environment.
- Manual device verification (install on a real iPhone/Android device) once
  signing works.

- Security review of key storage (explicitly called out in the issue) before
  any real credential is ever set in a deployed environment.
- Manual device verification (install on a real iPhone/Android device) once
  signing works.

## Automatic updates (issue #771)

Passes include `webServiceURL` (`APPLE_WALLET_WEB_SERVICE_URL`, e.g.
`https://<host>/api/wallet/apple`) and an `authenticationToken` (HMAC of the
serial under `WALLET_PASS_AUTH_SECRET`) when both are set. The serial number is
the capability digest, never the raw token.

- Web service: `app/api/wallet/apple/v1/[...path]/route.ts` →
  `lib/wallet-passes/updates.ts`; state in `wallet_passes` /
  `wallet_pass_registrations` (service-role only).
- Profile edits enqueue `wallet_pass:card_changed` outbox rows; the handler
  pushes over APNs at most once per coalescing window (5 min) and defers the
  rest via outbox retry.
- Account deletion voids passes (`voided: true`), pushes once, and removes
  registrations. `purge_voided_wallet_passes()` drops voided rows after 30 days.
- Google Wallet objects are not patched yet: the Google save-link JWT flow has
  no server-side REST credentials in this deployment.

### PassKit web-service contract checklist

Covered by `lib/wallet-passes/updates.test.ts`:

1. `POST /v1/devices/{device}/registrations/{type}/{serial}` → 201 new, 200 existing, 401 bad `ApplePass` token, 400 bad `pushToken`.
2. `GET /v1/devices/{device}/registrations/{type}?passesUpdatedSince=` → 200 `{serialNumbers, lastUpdated}` or 204.
3. `GET /v1/passes/{type}/{serial}` → 200 `.pkpass` with `Last-Modified`, 304 on `If-Modified-Since`, 401 bad token.
4. `DELETE /v1/devices/{device}/registrations/{type}/{serial}` → 200.
5. `POST /v1/log` → 200.

## NFC-enabled passes: spike report and ADR (issue #973)

Tracks issue [#973](https://github.com/Lafiya-xyz/Lafiya-web/issues/973): can a
responder tap a patient's phone lock screen and open the emergency card
**without the patient unlocking it**, using NFC-enabled wallet passes?

**Recommendation: NO-GO for now.** Do not build NFC pass support in this
cycle. Revisit only if the prerequisites in
[Requirements to flip to GO](#requirements-to-flip-to-go) are met. The
existing QR-on-lock-screen pass (above) already covers the "responder can get
to the card without the app" need; NFC would only remove the *scan* step, at
the cost of merchant enrollment, reader hardware, and a new replay surface.

### What the two platforms actually offer

| | Apple Wallet NFC (Value Added Services / VAS) | Google Wallet Smart Tap |
|---|---|---|
| Mechanism | Pass carries an NFC payload; a reader sends a VAS `getData` command and the pass responds with its payload while the phone is locked | Pass carries a Smart Tap payload; a reader sends a Smart Tap `collect` command and the pass responds while the phone is locked |
| Who can enroll | Requires an **Apple Developer Program** membership plus an **NFC-enabled Pass Type ID** and a VAS **merchant identifier**; Apple reviews the use case. Historically oriented at transit, access, loyalty, and event ticketing | Requires a **Google Wallet API issuer account** and **Smart Tap** enablement; Google reviews the use case. Same commercial orientation (transit, loyalty, ticketing) |
| Non-commercial / health use | Not an advertised category. No published self-serve path for "emergency medical card". Would need a written exception from Apple | Not an advertised category. Would need a written exception from Google |
| Reader side | Any NFC reader implementing the VAS protocol (Apple publishes the spec to enrolled merchants). **iPhones cannot read VAS passes**; Android phones can, with a custom app implementing VAS | Any NFC reader implementing Smart Tap. Android phones can read with a custom app; iPhones cannot |
| Payload | Small, opaque byte blob (order of a few hundred bytes) chosen by the issuer; Apple does not interpret it | Small, opaque byte blob chosen by the issuer; Google does not interpret it |
| Lock-screen behavior | Works while the phone is locked, by design — this is the whole point of VAS | Works while the phone is locked, by design |

Both are **merchant/issuer-gated programs**, not open protocols. Neither
platform documents a path for a non-profit health app to enroll without a
commercial use case, and neither will let us ship without their review.

### Payload: what we would transmit, and why it's the capability link

If we ever ship this, the NFC payload must be **exactly the same
capability-share URL** the QR code already encodes
(`https://.../card/c/<token>`) — nothing more. Rationale:

- The capability token is already the only thing the QR code carries, and
  `/card/c/[token]` re-checks expiry, revocation, and view budget on every
  access (`lib/emergency/capability.ts`). NFC must not become a second,
  weaker path.
- The payload is cached on the device and readable by any enrolled reader, so
  it must be treated as **public-to-anyone-who-taps**. That is acceptable only
  because the capability is short-lived, revocable, and view-budgeted — the
  same properties that make the printed QR code safe.
- No PHI, no name, no blood group, no field from `EMERGENCY_FIELD_ALLOWLIST`
  may ever be in the NFC payload. The structural guard in
  `lib/wallet-passes/passContent.test.ts` should be extended to cover the NFC
  payload if this is ever built.

### Replay risks

An NFC payload is a bearer credential: anyone who can read it can use it.
Compared to the QR code, NFC makes capture **easier and less visible** —
a reader can harvest the payload from a pocket or bag without the patient
noticing, and without the deliberate "hold up the QR code" gesture.

Mitigations that would be required before shipping:

- **Short capability TTL** for NFC-issued capabilities (minutes, not hours),
  separate from the printed-QR TTL.
- **Single-use or very low view budget** for NFC-issued capabilities, so a
  harvested payload is worthless after the first read.
- **Reader identity in the audit log**: the capability access log must record
  that the access came via NFC and, where the reader app reports it, a reader
  identifier — so abuse is detectable.
- **Revocation on demand** from the patient's app, with the same
  `wallet_pass:card_changed` outbox path used for pass updates.
- **No long-lived NFC payloads**: the pass must rotate its NFC payload on the
  same schedule as the capability, not once at install.

None of these are implemented today; the capability model supports them
(TTL, view budget, revocation) but the NFC-specific policy is not designed.

### Responder-side reading via Android phones

- Android phones can read both VAS and Smart Tap **only with a custom app**
  that implements the respective protocol; there is no built-in "read any
  wallet pass" feature. That means every responder would need the Lafiya
  responder app installed and the reader protocol implemented in it.
- iPhones cannot read either protocol at all, so an iPhone-using responder
  could not tap a patient's phone. This splits the responder fleet.
- The reader app would need NFC permission, background NFC handling, and a
  clear "tap the patient's phone" UX — plus a fallback to the QR code for the
  many responders without the app or without NFC.
- Net: NFC does not remove the need for the QR code; it adds a second,
  narrower path that only works for Android responders running our app.

### Privacy implications

- The NFC payload is readable by **any** enrolled reader, including readers
  not operated by Lafiya. We cannot know who tapped.
- Enrollment with Apple/Google means the platform knows a Lafiya pass exists
  and can read its metadata; the payload itself is opaque to them.
- The lock-screen read happens **without patient interaction**, so the patient
  cannot consent at the moment of the read. Consent must be captured at
  enrollment ("allow responders to tap my phone") and be revocable.
- This is a meaningful expansion of the capability's exposure surface and
  needs the same reviewer sign-off as any change touching capabilities
  (see `AGENTS.md`).

### Requirements to flip to GO

All of the following must be true before this becomes a GO:

1. **Written approval from Apple and Google** for a non-commercial emergency
   medical use case, including the NFC-enabled Pass Type ID / Smart Tap
   enablement.
2. **A responder reader app** (Android) implementing VAS and/or Smart Tap,
   with a QR fallback, shipped and adopted.
3. **NFC-specific capability policy**: short TTL, single-use/low view budget,
   reader identity in the audit log, on-demand revocation.
4. **Consent flow** at enrollment, revocable, explaining lock-screen reads.
5. **Security review** of the NFC payload and reader app by the capabilities
   reviewer.
6. **Structural test** extending `lib/wallet-passes/passContent.test.ts` to
   assert the NFC payload contains only the capability URL.

### ADR: NFC-enabled wallet passes for the emergency card

- **Status:** Proposed — **rejected for now** (no-go).
- **Context:** Responders should be able to reach the emergency card from a
  locked phone. QR-on-lock-screen already does this with a scan. NFC passes
  (Apple VAS, Google Smart Tap) would remove the scan step but require
  merchant enrollment, a custom Android reader app, and introduce a
  lock-screen-readable bearer credential.
- **Decision:** Do not implement NFC pass support. Keep the QR-on-lock-screen
  pass as the supported path. Re-evaluate if Apple/Google grant a
  non-commercial health exception and a responder reader app exists.
- **Consequences:** Responders still need to scan a QR code; iPhones and
  Android phones are treated equally (both show the QR code). No new replay
  surface, no new platform dependency, no new consent flow. The capability
  model is unchanged.
- **Related:** `lib/wallet-passes/`, `lib/emergency/capability.ts`,
  `lib/nfc/sun.ts` (existing NFC helper — unrelated to wallet passes; see its
  doc comment), issue #538 (wallet passes), issue #771 (pass updates).
