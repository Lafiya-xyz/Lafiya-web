# Error-budget policy

**Owner:** On-call platform team  
**Issue:** [#800 — Automate error-budget policy with release gating](https://github.com/org/lafiya-web/issues/800)  
**SLO:** Public emergency-card availability — 99.9% successful live resolutions over a rolling 30-day window

---

## 1. Purpose

This document defines:

1. How error-budget consumption is computed.
2. Burn-rate alert thresholds and their severities.
3. The deploy gate that blocks non-fix releases when the budget is exhausted or burning fast.
4. The override procedure, including who owns the decision to ship during exhaustion.
5. Where remaining budget is surfaced in the release workflow.

---

## 2. Error budget

The public-card availability SLO is 99.9% over a rolling 30-day window.

- **Total error budget:** `(30 days × 24 h × 60 min) × (1 − 0.999)` = **43.2 minutes** per rolling window.
- **Budget consumed:** `(window_seconds / 60) × error_rate`.
- **Budget remaining:** budget total minus consumed.

---

## 3. Burn-rate thresholds

Multi-window burn rates (see `scripts/error-budget.mjs`) are evaluated against the following thresholds:

| Window | Burn-rate threshold | Severity | Interpretation |
| --- | --- | --- | --- |
| 1 hour | > 14.4× | **page** | Budget exhausted in ~2 hours — block immediately |
| 6 hours | > 6.0× | **page** | Budget exhausted in ~5 hours — block immediately |
| 24 hours | > 3.0× | **warn** | Burning 3× faster than sustainable — advisory |
| 72 hours | > 1.0× | **warn** | Budget burning at above-sustainable rate — monitor |

A burn rate of 1.0 means errors are being consumed at exactly the rate the SLO allows. A burn rate of 14.4 over one hour means the entire 30-day budget is consumed in two hours.

---

## 4. Gate logic

`scripts/verify-release-gate.mjs` evaluates `release-evidence/error-budget-metrics.json` if present and produces one of three gate statuses:

| Status | Meaning | Release allowed? |
| --- | --- | --- |
| `open` | Budget healthy, no burn-rate alerts | Yes |
| `warn` | Elevated burn rate or < 10% remaining | Yes, with caution |
| `blocked` | Budget exhausted or page-severity alert | **No** — see override below |

Gate status is surfaced in the release workflow job summary under **Error-budget status**.

---

## 5. Override procedure

When the gate status is `blocked` and a release must proceed (e.g., the release _is_ the reliability fix), an explicit override is required.

### Steps

1. **Diagnose the cause.** Confirm the release addresses the availability issue that is burning the budget.
2. **Add an override record** to the release evidence JSON:
   ```json
   {
     "errorBudgetOverride": {
       "reason": "<explicit description of why this release addresses the reliability gap>",
       "actor": "<GitHub username of the person authorizing the override>"
     }
   }
   ```
3. **Submit for review.** The override requires a second approval from an independent reviewer (different from the release owner).
4. **Record in the incident log.** The override and its rationale are logged in the release evidence bundle and are permanently auditable.

### Who owns the decision

| Situation | Decision owner |
| --- | --- |
| Budget healthy (`open`) | Release owner |
| Budget warning (`warn`) | Release owner, documented in release notes |
| Budget blocked, no active incident | **Platform lead + independent security/treasury approver** |
| Budget blocked, active reliability incident | **On-call incident commander** — override is documented in the incident record |

The on-call platform team is responsible for the SLO and must be notified of any override.

---

## 6. Metrics input format

Place `release-evidence/error-budget-metrics.json` before running the release gate. Example:

```json
{
  "windowSeconds": 2592000,
  "sloTarget": 0.999,
  "totalRequests": 1000000,
  "successfulRequests": 999200,
  "windows": [
    { "label": "1h",  "totalRequests": 500,   "successfulRequests": 499 },
    { "label": "6h",  "totalRequests": 3000,  "successfulRequests": 2997 },
    { "label": "24h", "totalRequests": 12000, "successfulRequests": 11988 },
    { "label": "72h", "totalRequests": 36000, "successfulRequests": 35964 }
  ]
}
```

Metrics are sourced from synthetic probes and server route-class counters (see `docs/operations/mainnet-assurance.md` SLO catalog). Only safe dimensions are used — no patient identifiers, card URLs, or record hashes.

---

## 7. Budget display in release workflow

The mainnet release workflow (`mainnet-release.yml`) surfaces remaining budget in a **Error-budget status** section of the GitHub Actions job summary. Operators reviewing the release gate approval can see remaining budget at a glance without running scripts manually.

---

## 8. References

- `scripts/error-budget.mjs` — budget computation and gate logic
- `scripts/__tests__/error-budget.test.ts` — unit tests (healthy, burning, exhausted fixtures)
- `scripts/verify-release-gate.mjs` — release gate runner
- `.github/workflows/mainnet-release.yml` — mainnet release workflow
- `docs/operations/mainnet-assurance.md` — SLO catalog and alert thresholds
