# Spike: Stellar Anchor Off-Ramp for CHW Naira Payouts

Status: **spike / recommendation, not implemented in production.** Covers
the "evaluate integrating a Stellar anchor off-ramp" issue.

## Problem

CHWs are paid in USDC on Stellar (`CHW_INCENTIVE_POOL_ADDRESS`, see
`docs/chw-payout-indexer.md`), but they need naira in a bank account or
mobile-money wallet. USDC only matters if it's spendable. This spike
evaluates anchor options to bridge USDC -> NGN without Lafiya taking on money
transmission licensing itself.

## Candidate anchors and SEPs

| Anchor (indicative) | SEPs supported | KYC flow | Nigeria coverage | Notes |
|---|---|---|---|---|
| SDF test anchor (`testanchor.stellar.org`) | SEP-1, SEP-10, SEP-24 | Minimal, sandbox only | N/A (testnet only) | Used for the prototype below; no real payout capability. |
| Cowrie (NGN-focused Stellar anchor) | SEP-1, SEP-10, SEP-24, SEP-31 | Full KYC (BVN/NIN-linked) via their hosted interactive flow | Direct NGN bank + mobile money | SEP-24 interactive widget hosted by the anchor — Lafiya never touches KYC PII since the CHW completes it inside the anchor's own web view. SEP-31 (direct, sender/receiving anchor to anchor) would require Lafiya to become a "sending anchor," which brings its own compliance obligations — treat as a stretch goal, not the default path. |
| Yellow Card | SEP-24 (varies by market), also has a non-SEP REST/OTC API | Hosted KYC | Broad pan-African, NGN included | Non-SEP integration path exists and may have better settlement times/fees than SEP-24 in practice; worth a parallel spike, but out of scope for the SEP-first recommendation here. |
| Regional Nigerian VASP anchors (evaluate at implementation time) | Varies | Varies | Varies | The anchor landscape shifts quickly under evolving CBN/SEC guidance; a final anchor choice should be re-verified against `stellar.org/ecosystem/anchors` and each anchor's current SEP support before committing, rather than trusting this table as current at merge time. |

**Recommendation:** default to **SEP-24 interactive** with a
production-vetted NGN anchor (Cowrie or equivalent) rather than SEP-31.
SEP-24's hosted interactive KYC means the anchor — not Lafiya — collects and
custodies KYC PII, which keeps Lafiya out of the KYC data-handling business
entirely and minimizes the surface for a data-protection incident. SEP-31 is
a bare-metal cross-border rail that assumes *Lafiya* is itself a compliant
sending anchor with its own KYC/AML program; that's a materially bigger
regulatory lift than routing CHWs through an existing anchor's SEP-24 widget.

## KYC data flow (SEP-24)

1. CHW's wallet (or a Lafiya-hosted redirect) calls the anchor's SEP-24
   `/transactions/withdraw/interactive` endpoint, authenticated via SEP-10
   (a challenge transaction signed by the CHW's Stellar keypair — the same
   keypair already used for `chw-identity.ts` enrollment signing).
2. The anchor opens its own hosted web view where the CHW enters KYC details
   (name, BVN/NIN, bank account) **directly with the anchor**. This never
   transits Lafiya's servers, and Lafiya never stores it.
3. The CHW returns to the Lafiya app; the on-chain USDC payment to the
   anchor's deposit address, tagged with the anchor-issued transaction id
   memo, triggers off-chain NGN settlement to the CHW's bank/mobile-money
   account on the anchor's side.
4. Lafiya only needs to know: (a) the CHW-facing SEP-24 URL to redirect to,
   and (b) the anchor's transaction id / status, both of which are
   non-PHI, non-health data. **No Lafiya health data (blood group,
   genotype, allergies, conditions) is part of this flow at all** — the
   off-ramp only concerns the payout side of the system, which is already
   isolated from patient record data in the existing schema
   (`payout_obligations`/`payout_settlements` reference `chw_id`, never a
   patient or record id).

## Fees and settlement time (indicative — validate before production)

- SEP-24 anchors typically charge 0.5%-2% plus a fixed NGN-side fee; exact
  numbers require a commercial conversation with the chosen anchor and are
  not published in a way this spike can cite as authoritative.
- Settlement from on-chain USDC deposit to NGN landing in a bank account is
  typically minutes to a few hours for hosted anchors with existing NGN
  liquidity; mobile-money legs can be faster than direct bank transfer.
- These figures must be re-confirmed directly with the anchor's commercial/
  compliance team before this becomes a production dependency — do not
  treat the numbers above as commitments.

## Testnet prototype

See `lib/stellar/anchor/sep24-client.ts` for a minimal SEP-1/SEP-10/SEP-24
client scaffold against the SDF test anchor, covering: `stellar.toml`
discovery, SEP-10 challenge signing, and kicking off an interactive
withdrawal. It is a prototype only — no production anchor has been
contracted, no real KYC flow has been exercised, and no NGN has moved.

## Acceptance criteria status

- [x] Spike report with comparison matrix and recommendation (this doc).
- [x] Testnet prototype scaffold (`lib/stellar/anchor/sep24-client.ts`),
      wired against the SDF test anchor's published SEP endpoints. Not
      exercised end-to-end as part of this change (no test run, per task
      constraints) — a follow-up should run it against `testanchor.stellar.org`
      and record the actual interactive flow before this is considered
      validated.

## Out of scope

Production integration with a real NGN anchor, commercial/legal agreements,
and SEP-31 direct settlement are all out of scope for this spike.
