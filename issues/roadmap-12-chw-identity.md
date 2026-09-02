# [Spike] Evaluate CHW identity, wallet custody, and recovery options

## Category

Spike

## Question

How should Lafiya authenticate CHWs, bind their identity to an allowlisted Stellar address, and recover access without turning a lost wallet into lost earnings or an authorization bypass?

## Context

The web app has patient Supabase authentication, while the README describes allowlisted CHWs, Soroban attestations, and USDC payouts. The future verifier repository is planned and no CHW identity/custody model is defined.

## Why This Matters

The identity decision determines who may attest records, who receives payouts, how fraud is investigated, and whether field workers can use the product on low-connectivity devices.

## Areas to Investigate

- Supabase-authenticated CHW accounts with wallet binding.
- Passkeys, hardware wallets, wallet signing, and delegated transaction submission.
- Allowlist enrollment, rotation, suspension, and recovery governance.
- Custodial versus non-custodial payout models and threat boundaries.
- Device loss, shared devices, phishing, and offline recovery scenarios.

## Evaluation Criteria

Security, usability, regulatory/privacy exposure, recovery safety, transaction ergonomics, auditability, and compatibility with Soroban authorization.

## Expected Deliverables

Threat model, comparison matrix, recommended identity/custody architecture, proposed interfaces and lifecycle states, and a small authentication/signing proof of concept.

## Acceptance Criteria

- [ ] The design identifies the authoritative identity and Stellar-address binding.
- [ ] Enrollment, suspension, rotation, and recovery are specified.
- [ ] No recovery path lets an unauthorized actor attest or redirect payouts.
- [ ] The recommendation states which repository owns each component.
- [ ] Follow-up implementation work is bounded and sequenced.

## Follow-Up Opportunities

Implement CHW enrollment, wallet binding, transaction signing, and recovery controls in the verifier/contracts/web repositories.

## Cross-Repository Impact

`lafiya-verifier`, `lafiya-contracts` allowlist/authorization, `lafiya-web` request and payout APIs.

## Complexity

Spike

## Impact

Critical

## Suggested Labels

`spike`, `security`, `authentication`, `wallet`, `stellar`
