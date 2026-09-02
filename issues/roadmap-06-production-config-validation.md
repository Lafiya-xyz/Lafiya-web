# Add cross-field production configuration validation and a safe startup diagnostics route

## Category

Intermediate

## Summary

Validate incompatible or incomplete production combinations of attestation, Horizon, payout-indexer, and cron settings before traffic reaches a partially configured deployment.

## Current Behavior

`lib/env-server.ts` validates individual URLs and strings, but optional groups such as payout-indexer settings are not enforced as all-or-none combinations. `app/api/internal/payout-indexer/route.ts` discovers configuration failures only when invoked.

## Problem

A deployment can appear healthy while scheduled payout processing is disabled or misconfigured, delaying detection until a CHW misses a payout update.

## Why This Matters

Fail-fast configuration protects financial data integrity and makes deployments safer across testnet, staging, and production.

## Proposed Scope

Add Zod cross-field validation for enabled feature groups, a non-sensitive diagnostics result for operators, and CI checks covering testnet/local versus production-required settings. The diagnostics must never return secret values.

## Acceptance Criteria

- [ ] Partial payout-indexer configuration fails with an actionable server-side error.
- [ ] Attestation contract configuration validates its required network/RPC pairing.
- [ ] Local mock mode remains usable when the contract ID is intentionally absent.
- [ ] Diagnostics reveal enabled/disabled feature state without secrets or health data.
- [ ] CI exercises valid and invalid configuration matrices.

## Technical Considerations

Use `serverEnvSchema`, `.env.example`, the internal indexer route, and existing test environment conventions. Avoid parsing server-only values in client bundles.

## Testing Requirements

Test every feature group’s valid, missing, partial, and malformed configurations plus the local mock path.

## Cross-Repository Impact

Environment keys are documented as shared contracts with `lafiya-contracts` and deployment configuration; additive diagnostics may require docs updates.

## Out of Scope

Secret rotation, deployment-provider migration, or changing the underlying indexer behavior.

## Complexity

Intermediate — cross-field schema design touches configuration, routes, CI, and operational behavior.

## Impact

High — reduces silent production misconfiguration in the trust and payment paths.

## Suggested Labels

`intermediate`, `deployment`, `security`, `operations`
