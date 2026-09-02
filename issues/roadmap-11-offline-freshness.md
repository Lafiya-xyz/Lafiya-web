# [Spike] Define safe offline freshness and revocation policy for emergency cards

## Category

Spike

## Question

What maximum offline age and revocation behavior keeps cached emergency information useful without causing responders to trust dangerously stale or revoked cards?

## Context

`public/sw.js` caches visited `/card/*` HTML and injects a cached-at banner; it intentionally does not cache JavaScript. Cache bounds exist, but the repository has no product policy for maximum age, high-risk field changes, or online revocation checks after a card is cached.

## Why This Matters

Offline access is the product’s core differentiator, but stale allergies, medications, or revoked verification can create real clinical risk.

## Areas to Investigate

- Age-based expiry versus indefinite cache fallback.
- Field sensitivity and whether all emergency data should share one freshness policy.
- Revocation/status beacons that preserve offline usability.
- Patient-visible and responder-visible warning states.
- Service-worker cache versioning, rotation, and storage constraints.

## Evaluation Criteria

Clinical safety, offline usefulness, privacy, implementation complexity, browser support, and false-positive/false-negative risk.

## Expected Deliverables

Threat/safety analysis, policy recommendation with explicit age thresholds or rationale, prototype warning/expiry behavior, and follow-up implementation specification.

## Acceptance Criteria

- [ ] The analysis distinguishes cached freshness from on-chain attestation freshness.
- [ ] Revoked/rotated cards and unreachable-network behavior are addressed.
- [ ] The recommendation defines user-facing copy and failure states.
- [ ] The prototype is tested against the existing service-worker cache helpers.

## Follow-Up Opportunities

Implement policy-driven expiry, revocation markers, and updated offline UX.

## Cross-Repository Impact

`lafiya-web` service worker/public card; shared privacy/threat model in `lafiya-docs`.

## Complexity

Spike

## Impact

Critical

## Suggested Labels

`spike`, `offline`, `privacy`, `security`, `safety`
