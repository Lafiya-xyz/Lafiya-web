# [Spike] Evaluate Soroban attestation contract upgrade and allowlist governance

**Spike complete.** See
[`docs/attestation-contract-governance.md`](../docs/attestation-contract-governance.md)
for the threat model, option comparison, recommended lifecycle/state
model, upgrade/migration runbook, and proposed contract/web interface
changes. Implementation is tracked as follow-up issues per that doc's
§11.

## Category

Spike

## Question

What governance and upgrade strategy can correct a compromised attester, contract bug, or policy change without undermining historical verification evidence?

## Context

The README lists an attester allowlist and attestation registry in `lafiya-contracts`, but explicitly leaves allowlist management and governance undecided. `lafiya-web` treats contract ID and network as deployment configuration and reads revocation/expiry fields defensively.

## Why This Matters

Governance controls the trust root. An unsafe upgrade can invalidate legitimate medical verification, allow fraudulent attestations, or make the public card point at an obsolete contract.

## Areas to Investigate

- Soroban upgrade/admin patterns and immutable deployment alternatives.
- Multisig or role-separated allowlist administration.
- Attester suspension, historical validity, and emergency revocation.
- Contract ID/network versioning and web/verifier migration.
- Audit, transparency, and rollback requirements.

## Evaluation Criteria

Security, decentralization, incident response speed, backward compatibility, auditability, operational complexity, and user impact.

## Expected Deliverables

Governance threat model, option comparison, recommended lifecycle/state model, upgrade/migration runbook, and proposed contract/web interface changes.

## Acceptance Criteria

- [x] The design covers compromised admin and compromised attester scenarios.
- [x] Historical attestations have explicit validity semantics across upgrades.
- [x] Allowlist changes are auditable and replay-safe.
- [x] Web/verifier deployment migration and rollback are documented.
- [x] The recommendation identifies required contract tests and external audit scope.

## Follow-Up Opportunities

Implement governance roles, versioned contract configuration, emergency controls, and coordinated migration tooling.

## Cross-Repository Impact

`lafiya-contracts` upgrade/allowlist interfaces; `lafiya-web` configuration and attestation validation; `lafiya-verifier` trust configuration.

## Complexity

Spike

## Impact

Critical

## Suggested Labels

`spike`, `soroban`, `security`, `governance`, `cross-repository`
