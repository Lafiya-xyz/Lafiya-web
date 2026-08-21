# Attestation Contract Governance — Spike (Issue #164)

Answers `issues/roadmap-14-contract-governance.md`: what governance and
upgrade strategy corrects a compromised attester, a contract bug, or a
policy change without undermining historical verification evidence.

This is a design spike, not an implementation. The recommendation below
must be built in `lafiya-contracts` (Rust/Soroban) with matching changes in
`lafiya-web` (this repo) and `lafiya-verifier`. See
[Follow-up issues to open](#follow-up-issues-to-open) for how to split that
work.

## 1. Threat model

| Actor | Compromise | Blast radius today (no governance) | Detection |
|---|---|---|---|
| Contract admin | Private key leaked / insider | Total: attacker can push any WASM upgrade, rewrite the entire allowlist, drain the incentive pool. No separation exists — README's planned contract has a single implicit admin. | None — no events, no on-chain audit trail specified |
| A single attester (CHW) | Wallet key leaked / coerced | Attacker can call `attest()` for arbitrary record hashes for as long as the key stays allowlisted | None — `is_allowlisted` exists in the plan but `lafiya-web` never calls it (confirmed: no reference to `is_allowlisted` anywhere in this repo) |
| Contract logic | Bug in `attest`/`get_attestation`/allowlist check | Unknown until an upgrade path exists — today there's no way to fix a deployed bug without an undefined "just redeploy and hope config catches up" | None |
| Governance itself | Legitimate policy change (e.g. new attester eligibility rule) | Same code path as a malicious admin change — nothing distinguishes "policy update" from "attack" on-chain | None |

Two failure modes recur across all four rows and drive the design:

1. **No role separation.** "Can change the allowlist" and "can replace the
   contract code" are the same permission in the current (undesigned)
   plan. A leaked attester-admin key becomes a full contract compromise.
2. **No historical semantics.** Nothing says what happens to attestation
   #500, written six months ago by an attester suspended today. Without an
   explicit answer, any fix to (1) risks silently invalidating (or
   silently continuing to trust) old medical verification evidence.

## 2. Upgrade pattern options

Evaluated against: security, decentralization, incident response speed,
backward compatibility, auditability, operational complexity, user impact.

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A. Single-admin upgradeable** | One `Address` authorized to call `update_current_contract_wasm` and rewrite allowlist storage directly | Simplest to build; fastest incident response (one signature) | Single point of failure = single point of total compromise; no auditability of *who* on a team approved a change; fails "compromised admin" scenario outright |
| **B. Multisig-upgradeable, single contract** | N-of-M multisig (e.g. Soroban account contract or a small custom multisig) holds upgrade + allowlist authority over one contract | Removes single-key compromise; still simple mental model, one contract ID forever | Multisig covers *both* allowlist churn (frequent, low-risk) and WASM upgrades (rare, high-risk) with the same threshold — forces a choice between "too slow for routine attester changes" and "too fast for code upgrades" |
| **C. Split registry + governed pointer (recommended)** | Attestation *registry* logic is immutable per version. A small **governance/pointer contract**, itself multisig+timelocked, holds (a) the current allowlist and (b) the address of the current registry version. `attest()`/`get_attestation()` on the registry consult the pointer for allowlist state at call time. | Historical attestations stay permanently readable under an immutable contract — they can never be silently reinterpreted by a future upgrade. Allowlist changes (the frequent, urgent case) don't touch contract code. Full logic upgrades (the rare, dangerous case) require a new registry deployment + explicit pointer flip, which is auditable and reviewable as a discrete, rare event. | More moving parts than A/B; requires the pointer indirection to be threaded through `get_attestation` and through `lafiya-web`/`lafiya-verifier` reads |
| **D. Fully immutable, no upgrade path** | Deploy once, never upgrade; any change means a brand-new contract ID and a hard cutover | Maximum auditability, zero upgrade-authority risk | Fails incident response entirely — a compromised attester can't be suspended without redeploying everything; fails "correct a compromised attester ... without undermining historical evidence" outright |

**Recommendation: Option C**, with two distinct authorities inside the
pointer contract rather than one:

- **Allowlist admin** — N-of-M multisig, no timelock (or a short one, e.g.
  1 hour), scoped only to attester add/suspend/reinstate. This is the
  fast-response lever for a compromised attester.
- **Upgrade admin** — higher-threshold N-of-M multisig with a mandatory
  timelock (e.g. 48h, publicly visible before execution), scoped only to
  flipping the pointer to a new registry contract address. This is
  deliberately slow: a code upgrade is rare, and rushing one under attack
  pressure is itself a risk (see incident response runbook, §7).

Both authorities should be independent multisigs with non-overlapping
signer sets where practical, so compromising the (more frequently used,
lower-friction) allowlist-admin key cannot alone escalate to a contract
upgrade.

## 3. Lifecycle / state model

**Attester state** (per allowlist entry, held in the pointer/governance
contract):

```
Pending → Active → Suspended → Reinstated (→ Active)
                 ↘ Revoked (terminal)
```

- `Active`: eligible to call `attest()`.
- `Suspended`: not eligible for new `attest()` calls; existing
  attestations remain valid by default (non-retroactive — see §4).
  Reversible.
- `Revoked`: terminal removal (e.g. CHW leaves the program). Existing
  attestations remain valid by default; distinct from `Suspended` only in
  that reinstatement isn't expected.
- Every transition carries `effective_from: u64` (ledger timestamp) —
  never edits history, only appends a new state effective at a point in
  time.

**Attestation state** is derived, not stored as a single flag:

- `revoked: Option<bool>` (already planned) — this specific attestation
  was individually invalidated (e.g. clinical error, fraud proven for
  that one record). Retroactive by construction; this is the existing
  per-record kill switch and should stay.
- `expiry: Option<u64>` (already planned) — time-bound validity, unrelated
  to attester status.
- **New: attester status at read time.** `get_attestation` should return
  (or a paired `is_allowlisted`/`get_attester_status` call should expose)
  the attester's *current* state, not bake a trust decision into the
  registry. Whether "attested by a since-suspended CHW" counts as
  verified is a **verifier-side policy decision**, and different
  verifiers (a hospital vs. a border checkpoint) may reasonably disagree.
  The contract's job is to expose ground truth (`revoked`, `expiry`,
  attester status), not to collapse it into one boolean prematurely.

This directly answers the acceptance criterion "historical attestations
have explicit validity semantics across upgrades": **suspending or
revoking an attester never retroactively flips `revoked` on their past
attestations.** Only an explicit, individually-audited action against a
*specific* record hash sets that record's `revoked = true` (e.g. when an
investigation confirms a specific attestation was fraudulent). Attester
suspension alone is a forward-looking control, surfaced to callers as
attester-status metadata so each verifier can apply its own trust policy
to old records — not a silent, blanket rewrite of history.

## 4. Compromised-attester response

This is the common case and must be fast:

1. Any allowlist-admin multisig signer detects/receives a credible report
   (key leak, coercion, fraud pattern in the payout indexer — see
   `docs/chw-payout-indexer.md` for existing anomaly-relevant data).
2. Allowlist admin multisig calls `suspend_attester(address, reason_hash)`
   — reaches threshold, executes without timelock. Emits event (§5).
3. `is_allowlisted(address)` now returns `false`; `attest()` calls from
   that address revert going forward.
4. Past attestations from that address remain queryable and, per §3,
   are **not** auto-marked `revoked`. If specific past attestations are
   later confirmed fraudulent, each is individually revoked via
   `revoke_attestation(record_hash)` (separate, per-record action,
   separately audited).
5. `lafiya-web`/`lafiya-verifier` pick up the new attester status on next
   read (cache TTL bound — see §6) with no config change, no redeploy, no
   contract-ID change.

## 5. Auditability & replay-safety

- Every governance action (`suspend_attester`, `reinstate_attester`,
  `revoke_attestation`, pointer flip) **emits a Soroban event** with: the
  action, target, old→new state, `effective_from`, and the multisig
  signer set that authorized it. Soroban events are the audit log —
  no separate off-chain ledger needed, though mirroring them (see below)
  helps public transparency.
- **Replay-safety**: multisig-authorized calls must include a
  contract-local nonce/sequence number that increments on every
  successful governance call, checked and rejected if reused. This is
  required in addition to Soroban's transaction-level replay protection,
  because a *signed multisig payload* (e.g. "suspend attester X") could
  otherwise be resubmitted after being executed once, or after signer-set
  rotation, if the contract doesn't itself track "has this exact
  authorized action already run."
- **Transparency mirror**: reuse the pattern already built for CHW
  payouts (`docs/chw-payout-indexer.md`) — a scheduled indexer that mirrors
  governance events into an append-only, publicly queryable log. This
  makes "who changed the allowlist and when" answerable without running a
  Soroban RPC client, and gives `lafiya-web` a place to surface an
  "allowlist history" panel if needed later.

## 6. Contract ID/network versioning & migration

Because §2's recommendation keeps the **pointer contract's address**
stable across allowlist changes and even across most registry-logic
upgrades (the pointer is what moves, not what callers dial), `lafiya-web`
should mostly *not* need to change `ATTESTATION_CONTRACT_ID` in the common
case. Point `ATTESTATION_CONTRACT_ID` at the **pointer contract**, not
directly at a registry version.

For the rare case of a full migration (e.g. the pointer contract itself
needs replacing, not just re-pointed):

- Add `ATTESTATION_CONTRACT_ID_NEXT` (optional) alongside the existing
  `ATTESTATION_CONTRACT_ID` in `lib/env-server.ts` and `.env.example`.
- During a migration window, `getAttestation` reads the primary ID first
  and falls back to `ATTESTATION_CONTRACT_ID_NEXT` on a "not found"
  result (not on error) so record hashes written before cutover keep
  resolving without a code change.
- Cutover is a two-step config change (set `_NEXT`, verify, then promote
  `_NEXT` to primary and drop the old one), never an in-place edit of
  `ATTESTATION_CONTRACT_ID` — this keeps rollback to "revert the env var"
  rather than "figure out what the old value was."
- `lafiya-verifier` must follow the same primary/fallback read pattern
  since it's an independent reader of the same contract ID config
  (per README's Shared Contracts / Conventions for AI Agents section).

**Rollback**: because Option C never destroys a prior registry version
(old registries stay deployed and immutable), rollback of a bad upgrade is
"flip the pointer back," not "redeploy the old code." Web-side rollback is
reverting `ATTESTATION_CONTRACT_ID`/`_NEXT` and invalidating the
`unstable_cache` `attestation` tag (`revalidateTag("attestation")`, already
wired per the `TODO(#17 follow-up)` note in `lib/stellar/attestation.ts`)
so stale reads against the bad version don't linger past the cache TTL.

## 7. Compromised-admin / bad-upgrade response

Slower by design (§2), because rushing a code change under attack pressure
is itself a risk:

1. Upgrade-admin multisig signers are alerted (compromised key suspected,
   or a shipped upgrade has a confirmed bug).
2. If the *upgrade authority itself* is compromised (not just a bad
   upgrade from a legitimate process): the allowlist-admin multisig
   (separate signer set, §2) suspends all currently-active attesters as
   an emergency brake — this stops new fraudulent `attest()` calls
   immediately without touching contract code or waiting out the upgrade
   timelock.
3. A replacement registry contract (or a signer-set rotation on the
   pointer contract, if Soroban's account-abstraction primitives support
   in-place multisig membership changes) is proposed. The proposal and
   its timelock countdown are publicly visible on-chain (event log, §5)
   before execution — this is the auditable "did anyone object" window.
4. On execution, the pointer flips; old registry stays readable forever
   for historical verification (§6).
5. Web/verifier config updates per §6's two-step cutover; rollback path
   is available for the timelock's post-execution grace period if a
   fresh problem is found immediately after cutover.

## 8. Proposed `lafiya-contracts` interface (Rust pseudocode)

Extends the struct already documented in README's Soroban Smart Contract
Layer section — additive, not a breaking rename, so existing `record_hash`
/ `attester` / `timestamp` fields are untouched:

```rust
pub struct Attestation {
    pub record_hash: BytesN<32>,
    pub attester: Address,
    pub timestamp: u64,
    pub revoked: Option<bool>,      // already planned; per-record kill switch
    pub expiry: Option<u64>,        // already planned
}

pub enum AttesterState {
    Active,
    Suspended { effective_from: u64 },
    Revoked { effective_from: u64 },
}

// Pointer/governance contract
fn suspend_attester(admin_auth: MultisigProof, attester: Address, reason_hash: BytesN<32>);
fn reinstate_attester(admin_auth: MultisigProof, attester: Address);
fn get_attester_state(attester: Address) -> AttesterState;   // replaces bare is_allowlisted bool
fn set_registry(upgrade_auth: MultisigProof, new_registry: Address); // timelocked

// Registry contract (immutable per version)
fn attest(record_hash: BytesN<32>, attester: Address, timestamp: u64); // reverts if attester not Active per pointer
fn revoke_attestation(admin_auth: MultisigProof, record_hash: BytesN<32>); // per-record, separately audited
fn get_attestation(record_hash: BytesN<32>) -> Attestation;
```

`is_allowlisted(Address) -> bool` from the original plan is superseded by
`get_attester_state` — a bool can't express "suspended, formerly active,"
which §3/§4 require. Keep a thin `is_allowlisted` wrapper
(`state == Active`) if a simple boolean is still useful for `attest()`'s
own internal check.

## 9. Proposed `lafiya-web` interface changes

Concrete, actionable changes in *this* repo, ordered by whether they
depend on the `lafiya-contracts` work above:

**Independent of the contract work — do now:**

- `app/api/attestation/[recordHash]/route.ts:64-68` currently reports
  `verified: attestation !== null` using raw `getAttestation`, while
  `app/(public)/card/[id]/page.tsx` and `app/(auth)/profile/page.tsx`
  correctly use `validateAttestation` (checks `revoked`/`expiry`). This is
  a real, present-day inconsistency independent of any governance
  redesign: a revoked or expired attestation can read as `verified: true`
  through this route, which is documented as the intended integration
  point for `lafiya-verifier`. Fix: call `validateAttestation` (or add
  a `valid` field alongside the raw `attestation`) here as well.

**Depends on `lafiya-contracts` shipping §8:**

- Extend `lib/attestation/types.ts`'s `Attestation` type with an
  `attesterStatus?: "active" | "suspended" | "revoked"` field, sourced
  from the new `get_attester_state` call, decoded as defensively as
  `decodeAttestation` already handles `revoked`/`expiry`
  (`lib/stellar/attestation.ts:374`).
- `validateAttestation` stays a strict revoked/expiry check (unchanged
  contract with existing card/profile callers); add a separate
  `getAttestationTrustSignal(recordHash)` (or similar) that additionally
  surfaces `attesterStatus` for callers — like a future `lafiya-verifier`
  — that want to apply their own policy on "attested by a since-suspended
  CHW" rather than inherit `lafiya-web`'s default.
- `lib/env-server.ts`: add optional `ATTESTATION_CONTRACT_ID_NEXT` per
  §6; document both env vars in `.env.example` and README's Shared
  Contracts section.
- `getAttestation`'s fallback-on-not-found-to-`_NEXT` logic (§6) lives in
  `lib/stellar/attestation.ts` alongside the existing circuit
  breaker/timeout wrapper.

## 10. Required contract tests & audit scope

**Contract tests (`lafiya-contracts`), minimum bar before this ships:**

- Suspended attester's `attest()` call reverts; their prior attestations
  remain readable and `revoked` stays unset unless individually revoked.
- Multisig threshold enforcement on `suspend_attester`,
  `reinstate_attester`, `set_registry` — under-threshold auth rejected.
- Replay: resubmitting an already-executed authorized governance call
  (same nonce) rejected.
- Timelock: `set_registry` cannot execute before its timelock elapses;
  can execute after; can be observed (event) during the countdown.
- Pointer flip preserves old registry's readability — `get_attestation`
  against a record hash written under the prior registry version still
  resolves correctly post-flip (via whichever contract, old or new,
  actually holds it — this is the core "historical evidence" guarantee
  and deserves its own dedicated test, not just incidental coverage).
- `revoke_attestation` is scoped to a single `record_hash` and does not
  affect sibling attestations from the same attester.

**External audit scope**, prioritized by blast radius (matches §1):

1. Pointer/governance contract: multisig auth checks, replay/nonce logic,
   timelock enforcement — this is the trust root; a bug here undermines
   every other guarantee.
2. Allowlist state transitions (`suspend_attester`/`reinstate_attester`)
   and their interaction with `attest()`'s eligibility check.
3. Registry contract's `attest`/`get_attestation`/`revoke_attestation` —
   lower risk than (1)/(2) since it's immutable per version and has a
   smaller state surface, but still on-path for every read.

Out of scope for external audit (but in scope for this repo's own review):
`lafiya-web`'s decoding/caching layer, since it only reads and defensively
decodes already-audited on-chain state — a bug there degrades to
"verified indicator wrong," not "trust root compromised."

## 11. Follow-up issues to open

Per `roadmap-14`'s Follow-Up Opportunities, this spike's recommendation
splits into cross-repo implementation work:

- `lafiya-contracts`: implement pointer/registry split, multisig +
  timelock, attester state machine, event emission, replay-safe nonces
  (§8, §10).
- `lafiya-web`: fix the `/api/attestation/[recordHash]` revoked/expiry gap
  now (§9, independent); add `attesterStatus` plumbing once the contract
  ships (§9, dependent); add `ATTESTATION_CONTRACT_ID_NEXT` migration
  support (§6).
- `lafiya-verifier`: consume `attesterStatus` and apply its own trust
  policy rather than inheriting `lafiya-web`'s default (§9).
- Cross-repo: stand up the governance-event transparency mirror (§5),
  reusing the payout-indexer pattern.
