# Security Policy

## Supported Versions / Branches

This policy applies to all branches of the `lafiya-web` repository.

## Reporting a Vulnerability

Please report security issues **privately** via one of the following methods:

- **GitHub Private Security Advisory**: Open a private advisory through the repository's "Security" tab.
- **Email**: Send details to `security@lafiya-xyz.org` (encrypted email preferred).

All reports are automatically ingested into a **private GitHub Security Advisory** and tracked against the triage SLAs described below. See [Automated Intake & Triage SLAs](#automated-intake--triage-slas).

## Vulnerability Rewards Programme

We run a structured vulnerability rewards programme to incentivize researchers to test our most critical surfaces — **capabilities, Row-Level Security (RLS), attestation, and payouts** — safely and responsibly. This programme operates under the scoped safe harbour described below.

### In-Scope Assets

The following assets are **in scope** for the rewards programme:

| Asset | Description |
| --- | --- |
| **Capabilities** | Capability issuance, delegation, verification, and revocation logic. |
| **Row-Level Security (RLS)** | Supabase RLS policies, tenant isolation, and access-control boundaries. |
| **Attestation** | Attestation creation, signing, verification, and cryptographic handling. |
| **Payouts** | Payout calculation, disbursement flows, and Stellar transaction handling. |
| **Scanner / PDF Integrity** | Document scanner ingestion and PDF generation/validation integrity. |
| **Authentication** | Authentication and session handling in the web application. |
| **Private Data Handling** | Disclosure of any private data handling or cryptographic implementations. |

### Out-of-Scope

- Issues related to third-party services (Supabase, Stellar network) unless they directly affect the repository.
- Vulnerabilities requiring physical access to a victim's device.
- Social engineering, phishing, or spam against staff or users.
- Denial-of-service attacks against production infrastructure.
- Reports generated solely by automated scanners without a demonstrated impact.
- Best-practice or informational findings without a security impact.

### Prohibited Testing

To keep researchers and patients safe, the following are **strictly prohibited**:

- **No real patient data.** Do not access, exfiltrate, modify, or view real patient or personal health information (PHI). All testing must use the synthetic-data sandbox.
- **No production disruption.** Do not perform testing that degrades, interrupts, or denies service to production systems or real users.
- **No data destruction or persistence.** Do not modify, delete, or persist data outside the sandbox.
- **No testing against real user accounts.** Use only the dedicated test accounts and sandbox described below.
- **No public disclosure** of vulnerability details before a fix has been released (see Responsible Disclosure).

Testing outside these boundaries is not covered by safe harbour.

### Safe Harbour

When you make a good-faith effort to comply with this policy during your research, we will:

- Consider your research authorized and **not pursue or support legal action** against you.
- Work with you to understand and resolve the issue quickly.
- Recognize your contribution publicly (with your consent) once the issue is resolved.
- Not consider your actions a violation of the Nigeria Data Protection Act or our terms of service, provided you stay within the prohibited-testing boundaries above.

Safe harbour applies **only** to testing conducted within the in-scope assets and the synthetic-data sandbox. It does **not** extend to prohibited testing, out-of-scope assets, or any activity that risks real patient data or production availability.

### Synthetic-Data Sandbox

A dedicated sandbox environment with **synthetic data and test capabilities** is available for researchers. Use it for all testing — never production.

- **Entry point / setup**: see [`docs/partner-sandbox.md`](docs/partner-sandbox.md) for access instructions, test accounts, synthetic datasets, and test capabilities.
- The sandbox contains no real patient data and is isolated from production.

### Reward Tiers

Rewards are assessed by severity and impact, using the following tiers:

| Tier | Severity | Examples | Reward |
| --- | --- | --- | --- |
| **Critical** | Critical | RLS bypass exposing cross-tenant PHI, attestation forgery, payout manipulation enabling fund theft. | Highest reward |
| **High** | High | Capability escalation, authentication bypass, scanner/PDF integrity bypass with data impact. | High reward |
| **Medium** | Medium | Limited-scope access-control flaws, information disclosure of non-PHI data. | Medium reward |
| **Low** | Low | Minor issues with limited security impact. | Recognition / low reward |

Final reward amounts are determined by our triage team based on demonstrated impact and exploitability. Duplicate reports and out-of-scope findings are not eligible for rewards.

## Automated Intake & Triage SLAs

All vulnerability reports — whether submitted via GitHub Private Security Advisory or email — are **automatically ingested into a private GitHub Security Advisory** and tracked for triage SLA compliance.

### Triage SLA Targets

| Milestone | Target |
| --- | --- |
| **Acknowledge receipt** | Within **48 hours** |
| **Triage (severity & scope assessment)** | Within **5 business days** |
| **Full response / remediation plan** | Within **14 days** |

Critical vulnerabilities are prioritized and may be addressed faster.

### How SLAs Are Measured

- Each report is timestamped at **intake** (when it enters the private advisory).
- **Acknowledge SLA** is measured from intake to the first acknowledgement to the reporter.
- **Triage SLA** is measured from intake to the recorded triage decision (severity, scope, and reward eligibility).
- SLA metrics are tracked per advisory and reviewed regularly to ensure targets are met.

## Expected Response Time

We aim to acknowledge receipt of a report within **48 hours** and provide a full response within **14 days**. Critical vulnerabilities will be prioritized.

## Responsible Disclosure

We request that you do not publicly disclose details of the vulnerability until a fix has been released.

---

_This policy is aligned with the Digital Public Goods standards and the Nigeria Data Protection Act._