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
