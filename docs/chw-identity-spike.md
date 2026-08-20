# Spike: CHW identity, wallet custody, and recovery

Issue: `issues/roadmap-12-chw-identity.md`
Status: recommendation (not yet implemented)
Companion PoC: `lib/stellar/chw-identity.ts` (+ `lib/stellar/chw-identity.test.ts`)

## Executive summary

**Separate the *identity* root from the *authorization* root, and bind them with an admin-approved, proof-of-ownership record.**

- **Identity root = Supabase `auth.users`.** "Who is this human?" It drives what the CHW can *see and request* in `lafiya-verifier`, but never what lands on-chain by itself.
- **Authorization root = the Soroban allowlist in `lafiya-contracts`.** "May this Stellar address attest and receive payouts?" It is the only thing that makes `attest()` succeed, and the payout destination is already hard-bound to the allowlisted attester address by the indexer.
- **Binding = a new `chw_identities` table** (service-role writes only) that maps `auth.uid ↔ stellar_address`, carrying a SEP-53 signed proof that the enrollee controls the address. Both roots must move together: a binding change without a matching on-chain allowlist update (and vice-versa) does nothing.

**Custody recommendation (phased):**

1. **Phase 0 — pilot/testnet: custodial, per-CHW server-held key.** The verifier backend holds one Ed25519 key per CHW (never a shared pool) and signs `attest` after per-request authorization. Each account is created with a recovery co-signer so a lost server key never strands earnings. Smallest thing that works; acceptable on a supervised testnet pilot.
2. **Phase 1 — mainnet readiness: non-custodial device key + delegated session keys.** The signing key moves to the CHW's device (passkey-derived Ed25519 seed) with the enrolling organization as a co-signer for recovery, and short-lived Soroban *custom-account* session grants handle day-to-day signing so the cold key isn't touched per attestation.

The single non-negotiable invariant, stated once here and enforced everywhere below:

> **Recovering either secret (Supabase account or Stellar key) never grants the other. Off-chain identity cannot cause an attestation or a payout by itself; only the on-chain allowlist does. Every recovery and re-binding path is admin-approved, out-of-band, and auditable.**

---

## 1. Threat model

Actors: CHW, enrolling organization (NGO/facility), platform operator (`lafiya-verifier`/`lafiya-web` backend), contract/allowlist admin, patient, funder, external attacker.

### T1 — Compromised CHW Supabase account (phishing, credential reuse, self-service password reset)

- **Threat:** attacker authenticates as the CHW in the verifier UI.
- **Blast radius:** can *view* the CHW's queue/payouts and *request* actions; must not be able to attest or redirect payouts.
- **Control:** attestation requires the signing key and an active, admin-approved binding. In Phase 0 the key is server-side (attacker has no path to it through Supabase); in Phase 1 it is on the device (attacker doesn't have it). Payout redirection requires an admin-approved re-binding **plus** an on-chain allowlist update, and the indexer rejects any payout whose destination ≠ the allowlisted attester address.
- **Residual risk / mitigation:** identity recovery itself must be admin-gated (out-of-band human verification via the enrolling org), not self-service, otherwise Phase 0 signing is reachable through password reset.

### T2 — Lost or stolen CHW device (shared devices are a special case)

- **Threat:** attacker obtains the device and, in Phase 1, the device signing key.
- **Blast radius:** can sign attestations until the CHW reports the loss and the admin suspends the binding + removes the address from the allowlist.
- **Control:** per-CHW keys (no cross-CHW blast radius); session keys are short-lived and scope-limited; suspension flow exists and is fast; attestations are low-value and individually auditable.
- **Shared device mitigation:** never store a long-lived key unencrypted on a shared device; require re-auth + OS credential (PIN/biometric) per session; prefer short-lived session grants over the cold key.

### T3 — Compromised custody backend / operator (Phase 0)

- **Threat:** attacker exfiltrates server-held signing keys and signs attestations at will.
- **Blast radius:** every CHW whose key is in that store (bounded by per-CHW keys, not a shared pool); can also mint "earnings" via fake attestations that trigger payouts.
- **Control:** per-CHW keys in a KMS/secret store (never in source, never in the browser bundle); the **on-chain allowlist still gates** — a backend key is useless for an address that is not allowlisted, and the payout indexer only pays the allowlisted attester. This is the principal reason to move to non-custodial before mainnet.
- **Residual:** the operator can still sign *for already-allowlisted* CHWs, so the backend is a high-value target; bound it with KMS, least-privilege, audit logging, and Phase 1.

### T4 — Compromised allowlist admin / enrollment admin

- **Threat:** a rogue admin adds an attacker address to the allowlist or re-binds a CHW to an attacker address, redirecting payouts.
- **Blast radius:** arbitrary attestations and payout redirection; undermines the trust root.
- **Control:** shared with `issues/roadmap-14-contract-governance.md` — role separation, multisig admin, 4-eyes approval, immutable audit trail. The **proof-of-ownership step prevents silent binding**: the admin cannot bind an address the enrollee doesn't prove they control. On-chain and off-chain updates are cross-checked by reconciliation.

### T5 — Lost Stellar key / custody key (recovery is the point of this spike)

- **Threat:** CHW (or operator) loses the signing key; without a recovery design, the CHW loses future earnings or the operator is tempted to grant an insecure shortcut.
- **Control:** two independent, admin-approved recoveries (see §4). Earnings are not lost because the *account* (and its payouts) survive via a recovery co-signer; authority is not silently re-granted because recovery re-issues a *new* address through a fresh binding + allowlist update, never by resurrecting the old secret.

### T6 — Phishing / fake verifier app

- **Threat:** CHW enters credentials into a look-alike, or approves a fake signing prompt.
- **Control:** WebAuthn passkeys are origin-bound and phishing-resistant (Phase 1 primary credential, Phase 0 where supported); TOTP as fallback; enrollment and recovery always route through the enrolling org out-of-band.

### T7 — Offline / low-connectivity field work

- **Threat:** signing requires a live network; CHWs in dead zones can't attest, or a queued signed transaction is replayed/mutated later.
- **Control:** signing and submission are **decoupled** — the verifier can build+sign offline (Phase 0: queue the *request*, server signs on reconnect; Phase 1: CHW signs locally) and submit when connectivity returns. `attest` is idempotent per `record_hash` (one payout row per hash, enforced by `chw_payouts_record_hash_unique`), so delayed/replayed submissions don't double-pay.

### T8 — Patient-data leak via on-chain call

- Already a hard invariant in the README: only `record_hash`, attester identity, and timestamp cross the chain boundary. The signing path must be built so it can only sign these, never patient fields. (Enforced by review + the `recordHash` commitment scheme, not by this spike.)

---

## 2. Comparison matrix

Custody/signing options scored against the ticket's criteria. ● good, ◐ partial, ○ poor.

| Option | Security | Usability (low-conn./shared device) | Recovery safety | Tx ergonomics | Regulatory/privacy | Auditability | Soroban compat | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A. Custodial — per-CHW server key** | ◐ backend = target, but bounded per CHW | ● CHW just logs in | ● recovery = admin-gated Supabase + co-signer | ● server submits | ◐ operator custody of payout keys | ● server logs every sign | ● signs as account address | Phase 0 pick |
| B. Custodial — **shared** pool key | ○ one key = mass fraud | ● | ◐ | ● | ○ | ○ shared key muddies attribution | ◐ | rejected: no per-CHW attribution |
| **C. Non-custodial — passkey-derived device key** | ● no server secret | ◐ passkey UX on cheap/shared devices | ◐ needs recovery co-signer or key is lost | ◐ CHW signs each attestation (mitigated by sessions) | ● CHW self-custody | ● on-chain signatures attributable | ● | Phase 1 pick |
| D. Non-custodial — external wallet (Freighter/Albedo/Lobstr) | ● | ○ extra app, key backup burden | ◐ wallet's own recovery | ● wallet-native signing | ● | ◐ wallet address, not org identity | ● | pilot friction; not primary |
| E. Hardware wallet (Ledger/…) | ● best key protection | ○ cost, distribution, offline friction | ◐ seed recovery | ◐ | ● | ● | ● | per-CHW cost prohibitive at pilot scale |
| **F. Hybrid — device key + delegated session keys (custom account)** | ● | ● sessions remove per-tx friction | ● co-signer recovery + short-lived grants | ● | ● | ● session grant is auditable | ● (Soroban custom-account auth) | Phase 1 end-state |
| G. Hybrid — custodial + recovery co-signer | ◐→● | ● | ● | ● | ◐ | ● | ● | Phase 0 with an upgrade seam to F |

**Selected path:** **A (Phase 0) → F (Phase 1)**, with G's recovery co-signer present from day one so the cut-over doesn't strand anyone.

---

## 3. Recommended architecture

### 3.1 Authoritative identity and address binding

- **Authoritative identity** is Supabase `auth.users` (`chw_id = auth.uid`). CHWs reuse the existing Supabase auth rail; "is a CHW" is a claim (a row in `chw_identities`), not a separate auth system.
- **Authoritative Stellar authorization** is the allowlist in `lafiya-contracts`: an address is either allowlisted or not, and `attest()` requires both the signature and the allowlist entry.
- **Binding** is `chw_identities` (new table in `lafiya-web`):

```
chw_identities
  chw_id             uuid  PK, FK auth.users(id)
  stellar_address    text  (Stellar G… address)
  status             text  'pending' | 'active' | 'suspended' | 'rotating' | 'recovering' | 'offboarded'
  proof_challenge    text  (enrollment challenge the CHW signed)
  proof_signature    text  (SEP-53 signature over the challenge, hex)
  bound_at           timestamptz
  status_updated_at  timestamptz
  status_updated_by  uuid  (admin user or null)
  recovery_nonce     text  (rotated on each recovery to invalidate old proofs)
```

Rules:

- Only `service_role` writes `chw_identities`; no client RLS write policy (mirrors `chw_payouts` and `profile_secrets` conventions).
- `stellar_address` is the payout destination. The payout indexer already enforces `destination == attester`; this table becomes the *authoritative* source of "which `auth.uid` owns which address" for the verifier's payout view, but the on-chain allowlist remains the source of truth for authorization.

### 3.2 Signing and custody (phased)

**Phase 0 — custodial (pilot/testnet).**

- Enrollment service creates one Stellar account per CHW; the secret lives server-side (KMS/secret store), never in the client bundle.
- `lafiya-verifier` signs `attest` server-side only after: (a) the session is an authenticated CHW, (b) the binding is `active`, (c) the `record_hash` matches the claimed reattestation request, (d) the address is still allowlisted.
- The account is created with a **recovery signer** (org/admin multisig, threshold 2-of-2) so a lost custody key doesn't strand the account.

**Phase 1 — non-custodial (mainnet readiness).**

- The CHW's Stellar key is derived from a WebAuthn passkey (a 32-byte seed via HKDF) or held in a local wallet (option D).
- Day-to-day attestations use **short-lived, scope-limited session grants** via a Soroban custom-account (authorization by `Address::Contract`), so the cold device key is not exposed per transaction and sessions can be revoked individually.
- Recovery remains the org co-signer (Stellar account signer weights) — see §4.

### 3.3 Data flow

```
lafiya-verifier (CHW UI)          lafiya-web (server)              lafiya-contracts (Soroban)
  Supabase session  ──────────────▶  authz check: binding active
       │                                        │  sign attest (Phase 0)
       │                                        ▼
       │                              submit attest(record_hash, attester, ts)
       │                                        └──────────────▶  require_auth(attester)
       │                                                          is_allowlisted(attester) ? store
       │                                                                      │
       │◀── payout view (own rows) ◀── indexer: destination == attester ──────┘
```

---

## 4. Lifecycle states and recovery

| State | On-chain (allowlist) | Off-chain (`chw_identities.status`) | Who/what may act |
| --- | --- | --- | --- |
| `pending` | not allowlisted | invited, not yet bound | enrollee may submit proof |
| `active` | allowlisted | active | CHW may attest (subject to request authz); payouts flow |
| `suspended` | removed | suspended | nothing; admin may resume |
| `rotating` | old removed **after** new allowlisted | rotating | admin only; no attestation during window |
| `recovering` | removed | recovering | admin only; CHW proves identity out-of-band |
| `offboarded` | removed | offboarded | terminal; historical attestations retained |

### 4.1 Enrollment

1. Enrolling org vets the human out-of-band and creates a Supabase user.
2. Backend creates a `pending` binding and issues a **challenge**.
3. The enrollee proves they control a Stellar address by returning a SEP-53 signature over the challenge (`signMessage`/`verifyMessage`).
4. Admin approves → backend records `active` **and** calls `enroll_attester(address)` on-chain. Both steps are logged with the same operator identity.

### 4.2 Suspension (temporary revocation)

Admin (or the CHW reporting a lost device) triggers `suspend`: remove from on-chain allowlist (`remove_attester`) and set `status = 'suspended'`. Both are idempotent and re-playable. Resume re-runs the enrollment approval (proof may be reused if `recovery_nonce` unchanged).

### 4.3 Rotation (address change, e.g. key compromise)

Two-phase to avoid a gap or a double-address payout window:

1. Prove control of the **new** address (fresh challenge).
2. `enroll_attester(new)` **then** `remove_attester(old)` — atomic on-chain, and the off-chain `stellar_address` flips in the same transaction. Until both commit, the old address stays allowlisted so the CHW can keep working; the indexer's `destination == attester` check means no payout can go to an un-allowlisted address.

### 4.4 Recovery (the crux)

Two independent paths, both admin-approved, neither granting the other:

- **Identity recovery** (lost Supabase credentials): admin re-verifies the human out-of-band, issues new credentials. In Phase 0 this also re-enables server-side signing, **which is why it must never be self-service** — it is gated on out-of-band verification. In Phase 1 it does not touch the device key at all.
- **Key recovery** (lost device/wallet): the CHW proves identity out-of-band; admin runs the **rotation** flow to a new address. Earnings already paid to the old address are not lost (the account survives via the recovery co-signer in Phase 0; in Phase 1 payouts are to the allowlisted address and the org co-signer can re-key the account).

**Guarantee:** no recovery path re-issues a secret, silently re-allowlists an address, or redirects payouts. Every path changes *which address is bound+allowlisted* through an auditable, admin-approved transition, and the indexer enforces `destination == attester`.

---

## 5. Repository ownership

| Component | Owner | Note |
| --- | --- | --- |
| Soroban allowlist lifecycle (`enroll_attester`, `remove_attester`, `suspend_attester`, `attest` auth) | `lafiya-contracts` | shared with `roadmap-14` governance |
| Soroban custom-account session grants (Phase 1) | `lafiya-contracts` | new auth contract |
| `chw_identities` schema + RLS + service-role access | `lafiya-web` | migration + `lib/supabase/types.ts` |
| Enrollment/suspend/rotate/recover admin endpoints + proof verification | `lafiya-web` | server Route Handlers |
| Payout indexer (already enforces `destination == attester`) | `lafiya-web` | `lib/stellar/payout-indexer` |
| CHW auth UI, enrollment UX, signing (Phase 0 server, Phase 1 device + session) | `lafiya-verifier` | begins as routes inside `lafiya-web` |
| Threat model / recovery runbook (this doc's home) | `lafiya-docs` | mirror once agreed |

---

## 6. Proposed interfaces (sketch)

Contracts (Rust, `lafiya-contracts`):

```rust
fn enroll_attester(admin: Address, attester: Address);   // require_auth(admin); allowlist.add(attester)
fn remove_attester(admin: Address, attester: Address);   // require_auth(admin); allowlist.remove(attester)
fn suspend_attester(admin: Address, attester: Address, until: Option<u64>);
fn is_allowlisted(attester: Address) -> bool;
fn attest(record_hash: BytesN<32>, attester: Address, timestamp: u64); // require_auth(attester) + is_allowlisted
```

Web/verifier (server Route Handlers, `lafiya-web` + `lafiya-verifier`):

```
POST /api/chw/enroll        admin  → create pending binding + challenge
POST /api/chw/bind          CHW    → { address, proof_signature } → verify → pending→(admin)→active
POST /api/chw/suspend       admin  → allowlist remove + status=suspended
POST /api/chw/rotate        admin  → prove new → enroll(new) then remove(old)
POST /api/chw/recover       admin  → out-of-band verify → rotation
POST /api/chw/attest        CHW    → Phase 0: server signs; Phase 1: relay device signature
```

---

## 7. Acceptance-criteria traceability

| Acceptance criterion | Where satisfied |
| --- | --- |
| Authoritative identity + Stellar-address binding identified | §3.1 (Supabase `auth.uid` + on-chain allowlist + `chw_identities` binding with proof) |
| Enrollment, suspension, rotation, recovery specified | §4 |
| No recovery path lets an unauthorized actor attest or redirect payouts | §1 (T1/T3/T5) + §4.4 guarantee + indexer `destination == attester` |
| Recommendation states which repo owns each component | §5 |
| Follow-up implementation work bounded and sequenced | §8 |

## 8. Bounded, sequenced follow-ups

1. **`lafiya-web`** — add `chw_identities` migration + RLS + hand-authored types; add proof-verification helper (reuses `lib/stellar/chw-identity.ts`). *(No dependency.)*
2. **`lafiya-contracts`** — add admin-gated `enroll/remove/suspend_attester` (blocked on `roadmap-14` governance for the admin design). *(Depends on roadmap-14.)*
3. **`lafiya-verifier`** — Phase 0: custodial signing + enrollment + `attest` endpoint using the PoC's `buildAndSignAttestTransaction`. *(Depends on 1, 2.)*
4. **`lafiya-web`** — wire payout indexer/`chw_payouts` view to `chw_identities` for per-CHW earnings display; reconcile `chw_id` linkage. *(Depends on 1.)*
5. **`lafiya-verifier` + `lafiya-contracts`** — Phase 1: passkey-derived key + custom-account session grants + recovery co-signer. *(Depends on 3.)*
6. **`lafiya-docs`** — publish this threat model + recovery runbook once the model is agreed. *(Depends on 1–3 sign-off.)*

---

## 9. Proof of concept

`lib/stellar/chw-identity.ts` demonstrates the three crypto primitives the recommendation rests on, dependency-light and unit-tested:

- `deriveKeypairFromSeed` — passkey/WebAuthn-derived 32-byte seed → Stellar Ed25519 key (Phase 1 non-custodial root).
- `signAddressOwnership` / `verifyAddressOwnership` — SEP-53 signed challenge proving the enrollee controls an address (the enrollment binding; prevents silent payout redirection).
- `buildAndSignAttestTransaction` — the Phase 0 custodial path: the verifier backend signs the Soroban `attest` invocation with the per-CHW key.
