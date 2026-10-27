# Compliance Control Catalog

**Owner:** Privacy Engineering  
**Issue:** [#801 — Continuous compliance evidence collection](https://github.com/org/lafiya-web/issues/801)  
**Format version:** 1  
**Last reviewed:** 2026-10-23

Each control has a machine-checkable evidence source. Evidence is collected
automatically by `.github/workflows/compliance-evidence.yml` on a weekly schedule
and assembled into a signed bundle by `scripts/collect-compliance-evidence.mjs`.

---

## Control definitions

| ID | Control | Category | Evidence source | Frequency | Owner |
| --- | --- | --- | --- | --- | --- |
| CTL-001 | CI passes on every commit to main | Build integrity | GitHub Actions CI run result | Per commit | Platform |
| CTL-002 | Supply-chain checks pass (action pins, audit, SBOM provenance) | Supply chain | supply-chain.yml run result | Per commit | Platform |
| CTL-003 | Database RLS policies audited on every migration | Access control | database-security job result | Per commit | Privacy |
| CTL-004 | No high/critical production vulnerabilities (npm audit) | Vulnerability management | npm audit output in supply-chain.yml | Per commit | Platform |
| CTL-005 | Secret scan (TruffleHog) passes | Secret exposure | trufflehog step in supply-chain.yml | Per commit | Security |
| CTL-006 | SBOM generated and attested | Software transparency | SBOM artifact in supply-chain.yml | Per commit | Platform |
| CTL-007 | RoPA is up to date with database schema | Privacy documentation | generate-ropa step in CI | Per commit | Privacy |
| CTL-008 | Schema drift check passes | Data integrity | check-schema-drift.mjs in CI | Per commit | Platform |
| CTL-009 | Integration tests pass against local Supabase | Functional correctness | integration job in ci.yml | Per commit | Engineering |
| CTL-010 | Supabase exit restore drill rehearsed | Business continuity | restore-drill.yml quarterly run | Quarterly | Platform |
| CTL-011 | Release gate evidence complete before mainnet promotion | Release control | mainnet-release.yml gate result | Per release | Release owner |
| CTL-012 | Migration lint passes (no destructive ops without review) | Change management | lint-migrations.mjs in CI | Per commit | Platform |
| CTL-013 | No PHI in evidence artifacts (automated scan) | Privacy protection | PHI scan in compliance-evidence.yml | Per collection | Privacy |
| CTL-014 | Dependency updates reviewed via Dependabot | Dependency hygiene | dependabot.yml activity | Weekly | Platform |
| CTL-015 | ADR template enforced on all architecture records | Documentation quality | check-adr-template.mjs in CI | Per commit | Engineering |

---

## Evidence record format

Each evidence record written by `scripts/collect-compliance-evidence.mjs`:

```json
{
  "controlId": "CTL-001",
  "controlName": "CI passes on every commit to main",
  "collectedAt": "2026-10-23T06:00:00.000Z",
  "runId": "12345678",
  "runUrl": "https://github.com/org/lafiya-web/actions/runs/12345678",
  "outcome": "pass",
  "notes": "Optional context"
}
```

Records are stored in `compliance-evidence/<YYYY-MM-DD>/` and signed with a
SHA-256 manifest. A bundle for an auditor covers all records within a date range.

---

## PHI policy

No evidence artifact may contain Protected Health Information. Specifically:

- No patient names, dates of birth, contact details, national IDs, or health values.
- No card public IDs, revision IDs, record hashes, or commitment strings.
- No capability tokens, session cookies, or JWT contents.
- CI run URLs, job outcomes, timestamps, and run references are permitted.

Violations are detected by `scripts/scan-secrets.mjs` extended patterns and the
PHI scan step in `compliance-evidence.yml`.
