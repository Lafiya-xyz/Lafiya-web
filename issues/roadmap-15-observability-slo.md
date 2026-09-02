# [Spike] Define end-to-end reliability SLOs and privacy-safe observability

## Category

Spike

## Question

Which measurable SLOs, metrics, traces, and alerts are needed to operate emergency-card reads, attestation verification, and CHW payouts safely without logging patient health data?

## Context

The repository has `lib/logging/logger.ts`, Sentry initialization, Lighthouse budgets, a k6 workflow, and structured indexer logs. It does not define production SLOs for card latency, verification availability/freshness, payout lag, or service-worker success, nor a unified dashboard/alert model.

## Why This Matters

Without service-level signals, maintainers cannot distinguish a card outage from an attestation-provider outage or know when payout data is stale. Poorly chosen telemetry could also violate the project’s explicit no-health-data logging rule.

## Areas to Investigate

- Request, RPC, cache, indexer, and service-worker metrics.
- Sentry performance/error instrumentation versus platform metrics.
- Correlation IDs that are non-identifying and safe for health workflows.
- SLOs and alert thresholds for emergency and financial paths.
- Retention, access control, and redaction validation for telemetry.

## Evaluation Criteria

Actionability, privacy, measurement accuracy, cost, alert fatigue, implementation effort, and compatibility with Vercel/Supabase/Sentry.

## Expected Deliverables

SLO proposal, event/metric taxonomy, dashboard and alert design, redaction/threat review, and a small instrumentation proof of concept with sample data.

## Acceptance Criteria

- [ ] SLOs are defined for public-card latency/availability, attestation freshness, and payout freshness.
- [ ] Every proposed metric has an owner, aggregation, and alert rationale.
- [ ] The design proves sensitive profile fields and credentials are excluded.
- [ ] Failure classification distinguishes database, RPC, cache, and application errors.
- [ ] Follow-up implementation work is sequenced and bounded.

## Follow-Up Opportunities

Implement dashboards, alerts, safe correlation IDs, and production SLO checks in CI and deployment monitoring.

## Cross-Repository Impact

`lafiya-web` logging/Sentry/indexer; deployment platform; future verifier and contract event monitoring.

## Complexity

Spike

## Impact

High

## Suggested Labels

`spike`, `observability`, `privacy`, `reliability`, `operations`
