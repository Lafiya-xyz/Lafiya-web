# ADR-006: Passkey-based smart wallets (secp256r1 custom accounts) for CHWs

**Date:** 2026-11-20
**Status:** Proposed — spike complete, awaiting security review
**Issue:** [#903 — Support passkey-based smart wallets (secp256r1 custom accounts) for CHWs](https://github.com/Lafiya-xyz/Lafiya-web/issues/903)
**Related:** [ADR-002](./adr-002-chw-verification-protocol.md) (CHW verification protocol), [ADR-005](./adr-005-supabase-exit-hedges.md) (portability), [`docs/chw-identity-spike.md`](./chw-identity-spike.md) (identity/custody model)

---

## Context

Today a CHW's Stellar signing root is an Ed25519 secret key. In the Phase 0
pilot it is held server-side per CHW; the Phase 1 plan in
`docs/chw-identity-spike.md` derives it from a WebAuthn passkey seed (HKDF →
32-byte Ed25519 seed). Both variants have the same weakness: **the key is a
bearer secret**. Whoever reads the seed can attest and redirect payouts, and
there is no way to require a user-presence check at signing time.

Stellar Protocol 22+ ships `secp256r1_verify` as a Soroban host function, which
makes a **custom account contract** that verifies WebAuthn assertions on-chain
practical. The CHW's signing root then becomes a P-256 passkey in the platform
authenticator (Secure Enclave / StrongBox / TPM), and the "account" is a
contract whose `__check_auth` verifies the assertion. This ADR evaluates that
option as the default CHW signing method.

## Decision

**Adopt passkey smart wallets as the Phase 1 default for CHW signing, behind a
feature flag, with the existing Ed25519 allowlist path retained as the
fallback.** Do not make it the default for the Phase 0 pilot.

Rationale: the security gain (non-extractable key, phishing-resistant
user-presence per signature, no server-held secret) is real, but the recovery
and cost story is not yet proven on mainnet, and the pilot's supervised
testnet scope does not need it.

### 1. Account model

- One Soroban custom account contract per CHW, deployed with
  `deployer().with_address(salt, ...)` where `salt = sha256(passkey_pubkey ||
  chw_user_id)`. Address derivation is deterministic
  (`deriveSmartWalletAddress` in `lib/stellar/passkey-wallet.ts`), so
  re-enrollment is idempotent and the allowlist entry never has to move.
- `__check_auth` verifies `secp256r1_verify(pubkey, payload, r||s)` where
  `payload = authenticatorData || sha256(clientDataJSON)` and the client-data
  challenge is `createWalletChallenge({ networkPassphrase, contractId,
  payloadHashHex })`. Network and contract are inside the signed bytes, so an
  assertion cannot be replayed on another network or against another CHW's
  account.
- The contract stores exactly one P-256 public key plus a `sign_count`
  (monotonic, replay defence) and a `recovery_signer` (see §3). It stores no
  PII and no patient data — only the public key and the CHW's allowlist
  address, which is already public on-chain.
- The existing `chw_identities` binding (`auth.uid ↔ stellar_address`) is
  unchanged: the smart-wallet address simply becomes the bound address. The
  on-chain allowlist in `lafiya-contracts` remains the authorization root
  (ADR-002), so a compromised passkey still cannot attest unless the address is
  allowlisted.

### 2. Signing flow

1. Verifier builds the `attest` invocation and hashes its args →
   `payloadHashHex`.
2. Client calls `navigator.credentials.get()` with
   `challenge = createWalletChallenge(...)`, `userVerification: "required"`.
3. Client returns `authenticatorData`, `clientDataJSON`, and the raw 64-byte
   `r||s` signature; `buildSecp256r1SignatureScVal` encodes them for the
   contract's `__check_auth`.
4. The transaction is submitted with the smart-wallet contract as the source
   account. No secret ever leaves the device, and the server cannot sign on the
   CHW's behalf.

### 3. Recovery design

Passkeys are lost when a device is lost, and synced passkeys are lost when the
platform account is lost. Recovery must never let an unauthorized actor attest
or redirect payouts.

| Scenario | Path | Guard |
| --- | --- | --- |
| Device lost, passkey synced | Sign in on a new device with the same platform account | None needed — same credential |
| Device lost, passkey device-bound | **Recovery co-signer**: org-held Ed25519 key registered at enrollment | Co-signer can only `rotate_signer(new_pubkey)`; it cannot call `attest` or change the payout destination |
| Passkey compromised | Admin `suspend` → remove from allowlist → rotate signer | Two-phase, same as `docs/chw-identity-spike.md` §4.3 |
| Org key compromised | Admin removes co-signer, CHW re-enrolls with a fresh passkey | Requires the CHW's passkey (user presence) |

The co-signer is deliberately **not** a general co-signer on `attest`: it can
only rotate the signer, so a compromised org key cannot forge attestations or
redirect earnings. Payout destination stays hard-bound to the allowlisted
attester address by the indexer, so recovery cannot redirect funds.

### 4. Cost analysis

Per-CHW, testnet figures from the spike (Stellar base fee 100 stroops, ~1 XLM
per 10,000 operations at base fee; mainnet fee spikes are the dominant
variable):

| Item | Ops | Notes |
| --- | --- | --- |
| Deploy custom account (WASM upload, amortized) | ~1 upload + 1 deploy | Upload once per network; deploy per CHW |
| `__check_auth` per attestation | +1 `secp256r1_verify` (~25–30k CPU insns) | Adds roughly 10–20% to an `attest` invocation |
| Signer rotation | 1 invocation | Rare |
| **Ongoing per-CHW cost** | ~1 extra invocation per attestation | Dominated by base fee, not by the P-256 verify |

Conclusion: the marginal cost is **one extra host-function call per
attestation plus a one-off deploy**, which is small relative to the attestation
itself. The real cost risk is operational (WASM upgrades, contract
allowlisting), not fees. Exact CPU-instruction numbers must be measured on
testnet before mainnet sign-off — see §6.

### 5. SEP-45 evaluation

SEP-45 (Stellar Web Authentication for Contract Accounts) is the natural
off-chain login for a smart wallet: the server issues a challenge, the client
signs it with the passkey, and the server verifies via the account contract's
`__check_auth` simulation.

- **Fit:** good. It replaces the current SEP-10 flow for CHWs and removes the
  Ed25519 key from the browser entirely.
- **Gap:** SEP-45 is young; SDK and wallet support is thin, and our
  `app/api/sep10/*` routes plus `bindChwAddress` would need a parallel
  implementation rather than a swap.
- **Recommendation:** keep SEP-10 for the pilot; prototype SEP-45 alongside the
  smart-wallet rollout and switch only when the client SDK path is stable. Do
  not block the wallet work on SEP-45.

### 6. Prototype and reproducible steps

Off-chain primitives are implemented and unit-tested in
`lib/stellar/passkey-wallet.ts` (+ `lib/stellar/passkey-wallet.test.ts`):
authenticator-data/COSE parsing, challenge construction, signed-payload
assembly, ScVal encoding, and deterministic address derivation.

Testnet prototype (not yet run — requires network access and a deployed
contract):

1. `stellar contract upload --wasm secp256r1-account.wasm --network testnet`
2. `stellar contract deploy --wasm-hash <hash> --salt <sha256(pubkey||user_id)> --network testnet`
3. Register a passkey in the browser (`navigator.credentials.create()` with
   `pubKeyCredParams: [{ type: "public-key", alg: -7 }]`), parse the response
   with `parseAuthenticatorData`, and store the 65-byte key on the contract.
4. Build an `attest` invocation, derive `payloadHashHex`, call
   `createWalletChallenge`, sign with `navigator.credentials.get()`, encode with
   `buildSecp256r1SignatureScVal`, and submit.
5. Record the resulting transaction hash and the measured CPU instructions for
   `__check_auth` in this ADR.

## Consequences

- **Positive:** no extractable CHW signing secret; phishing-resistant
  user-presence per attestation; deterministic addresses keep the allowlist
  stable; recovery cannot redirect payouts.
- **Negative:** new contract surface to audit and upgrade; passkey availability
  on cheap/shared Android devices is uneven (fallback path required); SEP-45
  immaturity; one extra host-function call per attestation.
- **Neutral:** `chw_identities` and the on-chain allowlist are unchanged, so
  this is additive to ADR-002 rather than a replacement.

## Follow-ups

1. `lafiya-contracts` — `secp256r1-account` contract with `__check_auth`,
   `rotate_signer`, and `sign_count` replay defence; pgTAP/Rust tests.
2. `lafiya-web` — feature-flagged passkey enrollment UI and SEP-45 challenge
   route; reuse `lib/stellar/passkey-wallet.ts`.
3. Measure `__check_auth` CPU instructions on testnet and replace the §4
   estimates with measured values.
4. Security review of the recovery co-signer scope before mainnet.
