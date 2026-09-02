# Implement privacy-preserving, time-boxed emergency-card sharing links

## Category

Advanced

## Summary

Add an optional sharing mechanism that lets a patient issue a revocable, time-limited card link while preserving the no-login responder path and offline behavior for intentionally shared cards.

## Current Behavior

The public card is reachable by a bearer `card_public_id`, and `regenerateCardId` rotates that identifier. The service worker caches visited cards, and the public RPC exposes the emergency projection to anyone holding the URL. The open access-observability issue does not provide an implemented sharing-scope protocol.

## Problem

A copied QR/link remains usable until rotation, while rotation is coarse-grained and can invalidate all existing printed materials. There is no least-privilege, time-boxed sharing option.

## Why This Matters

Patients need practical control over sensitive emergency data without requiring a responder to authenticate or depend on a network at the moment of care.

## Proposed Scope

Design and implement signed or opaque scoped tokens with expiry, revocation, rate limits, server validation, cache semantics, and a patient UI for issuing/revoking scopes. Define what offline cached content means after scope expiry and show explicit freshness/authorization status.

## Acceptance Criteria

- [ ] A patient can create and revoke a scope without exposing account identifiers.
- [ ] Expired/revoked scopes fail on the network and cannot be refreshed anonymously.
- [ ] Token guessing, replay, and enumeration are addressed with measured controls.
- [ ] Offline cards clearly indicate cached authorization age and do not claim a live scope is valid.
- [ ] Audit events omit emergency health data and are access-controlled.

## Technical Considerations

Coordinate `get_emergency_card`, `public/sw.js`, card-ID rotation, rate limiting, cache invalidation, and privacy threat model. Avoid putting health data or long-lived signing secrets in browser storage.

## Testing Requirements

Test token lifecycle, cross-user isolation, expiry/revocation races, cache fallback, brute-force resistance, and accessibility of status messaging.

## Cross-Repository Impact

Potentially shared public-card link semantics in `lafiya-docs`; no contract change is expected unless scopes are anchored on-chain.

## Out of Scope

Responder accounts, mandatory network connectivity, and blockchain-based access control.

## Complexity

Advanced — combines security protocol design, caching, offline semantics, and patient UX.

## Impact

High — improves privacy control while expanding safe emergency sharing.

## Suggested Labels

`advanced`, `security`, `privacy`, `offline`, `product`
