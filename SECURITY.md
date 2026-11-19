# Security Policy

## Supported Versions / Branches

This policy applies to all branches of the `lafiya-web` repository.

## Reporting a Vulnerability

Please report security issues **privately** via one of the following methods:

- **GitHub Private Security Advisory**: Open a private advisory through the repository's "Security" tab.
- **Email**: Send details to `security@lafiya-xyz.org` (encrypted email preferred).

## Scope

**In‑scope**:

- Security vulnerabilities in the web application code, including authentication, RLS, and attestation handling.
- Disclosure of any private data handling or cryptographic implementations.

**Out‑of‑scope**:

- Issues related to third‑party services (Supabase, Stellar network) unless they directly affect the repository.

## Expected Response Time

We aim to acknowledge receipt of a report within **48 hours** and provide a full response within **14 days**. Critical vulnerabilities will be prioritized.

## Responsible Disclosure

We request that you do not publicly disclose details of the vulnerability until a fix has been released.

## Source Integrity: Signed Commits and Protected Tags

Supply-chain integrity extends to the source itself. Unsigned commits and mutable tags allow impersonation of maintainers, so the following controls are enforced:

- **Signed commits on `main`**: The `main` branch is protected and requires all commits to be cryptographically signed. Signatures may use Sigstore **gitsign** (keyless, OIDC-based) or SSH/GPG keys. Unsigned commits cannot land on `main` — pull requests containing unsigned commits will fail the required checks and cannot be merged.
- **Protected release tags**: Tags matching `v*` (and other release tags) are protected and cannot be moved, deleted, or force-pushed. Release tags must be signed, and the release workflow verifies each tag's signature against an allowlist of maintainer identities before publishing. A release whose tag signature cannot be verified will not proceed.
- **Contributor setup**: See `CONTRIBUTING.md` for step-by-step instructions on configuring gitsign or SSH/GPG commit signing and signing release tags.

### Reporting Suspected Impersonation or Unsigned Releases

If you suspect a commit, tag, or release was created by an impersonator, or you observe an unsigned commit on `main` or an unsigned/unverified release tag, report it privately using the same channels listed under [Reporting a Vulnerability](#reporting-a-vulnerability):

- **GitHub Private Security Advisory** (preferred for source-integrity issues), or
- **Email**: `security@lafiya-xyz.org`.

Please include the affected commit SHA(s), tag name(s), release URL(s), and any evidence of the discrepancy (for example, a failed signature verification output). Do **not** open a public issue or discuss the suspected impersonation publicly. These reports are treated as high priority under the response times above.

---

_This policy is aligned with the Digital Public Goods standards and the Nigeria Data Protection Act._