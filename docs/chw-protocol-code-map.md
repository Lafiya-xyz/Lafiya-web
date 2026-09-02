# CHW Protocol Code Map

> **Purpose:** Bridge document between [ADR-002](adr-002-chw-verification-protocol.md) and the
> implementation in `lib/chw-protocol/`. Read the ADR first to understand _why_ each concept
> exists; use this map to go straight to the file and export that owns it.

---

## File overview

| File | Responsibility |
|------|---------------|
| `lib/chw-protocol/types.ts` | All shared types, enums, and the `ProtocolError` class |
| `lib/chw-protocol/config.ts` | Deployment identity, runtime environment guard, attestation mode |
| `lib/chw-protocol/intent.ts` | HMAC signing and verification of attestation intents |
| `lib/chw-protocol/trust.ts` | Evidence-to-trust-state projection |

---

## Concept → file/export map

### Trust levels (ADR §"Request, intent, and trust")

The ADR defines eight trust states that a record can occupy.

| ADR trust state | TypeScript type / value | File |
|-----------------|------------------------|------|
| `TrustState` union type (`"unverified" \| "submitted" \| "confirming" \| "verified" \| "expired" \| "revoked" \| "superseded" \| "conflicted" \| "unavailable"`) | `type TrustState` | `lib/chw-protocol/types.ts` |
| Evidence bag fed into the projection function | `type TrustEvidence` | `lib/chw-protocol/trust.ts` |
| Projection function (evidence → `TrustState`) | `function resolveTrustState(evidence, now?)` | `lib/chw-protocol/trust.ts` |

`resolveTrustState` implements the conservative ordering stated in the ADR:
_"Provider success can only produce `confirming`, never `verified`."_
It checks `requestCurrent`, `providerConflict`, `providerAvailable`, `revoked`,
`expiresAt`, `finalized`, `observed`, and `intentSubmitted` in that exact precedence
order.

---

### Verification intents (ADR §"Request, intent, and trust")

The ADR describes a canonical, HMAC-signed, short-lived intent that binds the
CHW identity, record revision, network, contract version, and idempotency key.

| ADR concept | TypeScript type / value | File |
|-------------|------------------------|------|
| Shape of the unsigned intent payload | `type AttestationIntentPayload` | `lib/chw-protocol/types.ts` |
| Signed envelope (payload + signature) | `type SignedAttestationIntent` | `lib/chw-protocol/types.ts` |
| Issue a signed intent | `function signAttestationIntent(payload, signingKey)` | `lib/chw-protocol/intent.ts` |
| Verify integrity + expiry before acceptance | `function verifyAttestationIntent(intent, signingKey, now?)` | `lib/chw-protocol/intent.ts` |

`AttestationIntentPayload` carries the fields the ADR mandates:
`requestId`, `revisionId`, `recordCommitment`, `schemaVersion`, `chwId`,
`stellarAddress`, `epoch` (network-passphrase hash, contract ID/version, event version),
`idempotencyKey`, `issuedAt`, `expiresAt`, and a `version: 1` discriminant.

---

### Protocol configuration / deployment identity (ADR §"Epochs, operations, and rollout")

The ADR requires that production rejects mock attestations and incomplete
protocol configuration. `config.ts` enforces this as a fail-closed boundary.

| ADR concept | TypeScript type / value | File |
|-------------|------------------------|------|
| Runtime config shape | `type ProtocolRuntimeConfig` | `lib/chw-protocol/config.ts` |
| Read + validate config (throws `ProtocolError` if production invariants are violated) | `function getProtocolRuntimeConfig(env?)` | `lib/chw-protocol/config.ts` |
| Allowed deployment identities | internal `deploymentSchema` (`z.enum([...])`) | `lib/chw-protocol/config.ts` |
| Allowed attestation modes | internal `modeSchema` (`z.enum(["mock", "live"])`) | `lib/chw-protocol/config.ts` |

Production/mainnet deployments fail before serving traffic if:
- `attestationMode !== "live"` (mock forbidden in production)
- `intentSigningKey` or `epochId` is absent

---

### Protocol epochs (ADR §"Epochs, operations, and rollout")

An epoch pins the schema version, network, contract, event version, and
finality depth together. The ADR states that an upgrade adds a new epoch
and retains the old one for historical interpretation.

| ADR concept | TypeScript type / value | File |
|-------------|------------------------|------|
| Epoch shape | `type ProtocolEpoch` | `lib/chw-protocol/types.ts` |
| Epoch status values (`"active" \| "deprecated" \| "retired"`) | part of `ProtocolEpoch` | `lib/chw-protocol/types.ts` |
| Epoch fields embedded inside an intent | `AttestationIntentPayload.epoch` (`Pick<ProtocolEpoch, ...>`) | `lib/chw-protocol/types.ts` |

---

### Error handling (used throughout)

All protocol violations throw a typed error rather than a plain `Error`.

| ADR concept | TypeScript type / value | File |
|-------------|------------------------|------|
| Typed error class | `class ProtocolError` (has `.code: ProtocolErrorCode`) | `lib/chw-protocol/types.ts` |
| Exhaustive error code list | `const PROTOCOL_ERROR_CODES` (tuple used to derive the union) | `lib/chw-protocol/types.ts` |
| `type ProtocolErrorCode` (string union) | derived from `PROTOCOL_ERROR_CODES` | `lib/chw-protocol/types.ts` |

Notable codes and where they are thrown:

| Code | Thrown in |
|------|-----------|
| `INVALID_INTENT` | `intent.ts` — missing key, bad structure, wrong version, signature mismatch |
| `INTENT_EXPIRED` | `intent.ts` — `expiresAt` has passed |
| `UNSUPPORTED_EPOCH` | `config.ts` — production/mainnet safety guards |
| `PRODUCTION_MOCK_FORBIDDEN` | `config.ts` — mock mode in a production deployment |
| `PRODUCTION_PROTOCOL_CONFIG_INCOMPLETE` | `config.ts` — missing `epochId` or `intentSigningKey` in production |
| `INTENT_SIGNING_KEY_REQUIRED` | `config.ts` — live attestation mode without a signing key |
