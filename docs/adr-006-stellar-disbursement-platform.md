# ADR-006: Stellar Disbursement Platform for CHW payouts — partial integration

**Date:** 2026-11-20  
**Status:** Proposed  
**Deciders:** Platform lead, Privacy lead, Finance/Operations lead  
**Issue:** [#905 — Evaluate the Stellar Disbursement Platform for CHW payouts](https://github.com/Lafiya-xyz/Lafiya-web/issues/905)

---

## Context

CHW incentives are paid today as USDC transfers from a single operator-held
account, `CHW_INCENTIVE_POOL_ADDRESS`, on Stellar. The in-house stack is:

- **Payment execution:** manual/scripted transfers from the incentive pool
  account. No payout policy lives in this repository — the amount is whatever
  the operator actually sent on-chain (see
  [`docs/chw-payout-indexer.md`](./chw-payout-indexer.md)).
- **Settlement recording:** `lib/stellar/payout-indexer/` pages Horizon
  payments for the pool address, matches each transfer to an attestation
  `record_hash`, and calls `apply_chw_payout` to persist
  `chw_payouts.amount_usdc`, `payout_tx_hash`, `status`, `paid_at`.
- **Receiver UX:** `GET /api/chw/payouts` (cursor-paginated, RLS-scoped) shows
  the CHW their own payout history.
- **Auditability:** on-chain transaction hash + `chw_payouts` row + the
  attestation it settles. Reconciliation is passive: the indexer records what
  happened, it does not drive payment.

The Stellar Disbursement Platform (SDP) is an open-source, self-hostable
disbursement service (API + admin UI + wallet) that batches payments to
recipients, tracks a per-recipient payment lifecycle
(`DRAFT → READY → PENDING → SUCCESS/FAILED`), and supports receiver
registration and off-ramp integrations.

The question: adopt SDP, partially integrate it, or keep the in-house stack?

---

## Comparison matrix

| Dimension | In-house (today) | Stellar Disbursement Platform | Assessment |
| --- | --- | --- | --- |
| **Payment execution** | Operator-scripted transfers from one pool account; no batching, no retry state machine | Batched disbursements with per-recipient state machine, retries, and a review/approval step before submission | SDP stronger |
| **Payout policy location** | Outside the repo entirely (operator decides amounts) | Amounts and recipient lists are first-class SDP records, reviewable before send | SDP stronger, but policy still human |
| **Security — key custody** | Pool account secret held by operator; app never signs | SDP holds a distribution account secret (env/KMS-backed); adds a second signing surface and an admin UI with its own auth | In-house simpler; SDP needs hardening review |
| **Security — app surface** | No new attack surface; indexer is read-only against Horizon | New internet-facing API + admin UI + receiver registration endpoints; must be network-restricted and patched | In-house stronger by default |
| **Data residency** | Only `record_hash`, amount, tx hash, timestamps stored in Postgres (Supabase region) | SDP stores recipient PII (name, phone, bank/wallet details) in its own Postgres — a **new** PII store outside the current DPIA/ROPA | In-house stronger; SDP requires DPIA amendment |
| **PHI exposure** | None: payouts reference `record_hash` only | None by design, but receiver records invite PII creep; must enforce "no clinical data in SDP" | Tie if governed |
| **Cost** | Horizon/RPC calls + one cron invocation; effectively free | Self-hosted: compute + Postgres + ops time; hosted: per-disbursement fees | In-house cheaper at current volume |
| **Receiver UX** | CHW sees a read-only payout list in-app; no registration, no wallet onboarding | Receiver registration flow, SMS/email notifications, wallet or bank off-ramp | SDP stronger |
| **Auditability** | On-chain tx hash + `chw_payouts` row + attestation link; reconciliation is passive and idempotent | Full disbursement audit trail (who approved, what batch, per-recipient status) plus on-chain hash | SDP stronger for *initiation*; in-house already sufficient for *settlement* |
| **Operational burden** | One cron job, one secret rotation runbook | New service to deploy, upgrade, back up, monitor, and rotate secrets for | In-house stronger |
| **Migration risk** | — | Replacing the indexer would break the `record_hash` ↔ payout join that attestation and funder reporting depend on | High if adopted wholesale |

---

## Decision

**Partial integration — keep the in-house settlement ledger and indexer as the
system of record; do not adopt SDP as the payout system of record.**

Concretely:

1. **Keep** `lib/stellar/payout-indexer/`, `chw_payouts`, and
   `GET /api/chw/payouts` unchanged. They remain the authoritative,
   `record_hash`-linked settlement record used by attestation and funder
   reporting.
2. **Do not** move recipient PII into SDP in this phase. Any future SDP
   receiver registration requires a DPIA/ROPA amendment and a documented
   residency decision first.
3. **Revisit SDP only for the initiation layer** — batched submission with an
   approval step — if payout volume grows past what operator-scripted
   transfers can safely handle. If that happens, SDP becomes a *sender* whose
   on-chain transfers the existing indexer continues to record; the indexer
   contract does not change.
4. **Adopt two SDP ideas without the service**, as small in-house follow-ups:
   an explicit per-payout state machine (`pending → paid → failed`) already
   partially present in `chw_payouts.status`, and a documented approval step
   for pool-account transfers in the operator runbook.

---

## Consequences

**Positive:**
- No new PII store, no new internet-facing service, no change to the
  `record_hash` ↔ payout join that downstream reporting depends on.
- Settlement auditability is unchanged and already on-chain verifiable.
- The door stays open: SDP can be introduced later purely as an initiation
  layer without touching the indexer or the API.

**Negative / accepted risks:**
- Receiver UX stays minimal (read-only in-app history, no SMS/off-ramp).
  Accepted until CHW volume justifies the operational cost.
- Payout initiation remains manual and outside the repository, so payout
  policy is still not code-reviewed. Mitigated by the operator runbook
  approval step above.
- If SDP is adopted later, its admin UI and receiver PII will need a security
  review and a DPIA amendment before go-live.

---

## References

- [`docs/chw-payout-indexer.md`](./chw-payout-indexer.md) — current settlement
  recording and event-source decision.
- [`docs/adr-005-supabase-exit-hedges.md`](./adr-005-supabase-exit-hedges.md) —
  data-residency and portability posture.
- [`docs/compliance/dpia.md`](./compliance/dpia.md),
  [`docs/compliance/ropa.md`](./compliance/ropa.md) — PII inventory that any
  SDP adoption must amend.
