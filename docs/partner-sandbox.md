# Partner sandbox

Integrators can exercise the verifier API (`GET /api/attestation/{recordHash}`)
against synthetic data without touching patient records or mainnet funds.

This page also documents the **researcher sandbox** used by the vulnerability
rewards programme. The programme policy (scope, safe harbour, reward tiers and
prohibited testing) lives in [`SECURITY.md`](../SECURITY.md); this page covers
how to get access and what the sandbox isolates.

## Credentials

Request a sandbox key from the maintainers. Keys start with `lfy_sbx_` and are
configured server-side in `LAFIYA_SANDBOX_API_KEYS` (comma-separated). Send it
as a bearer token:

```bash
curl -H "Authorization: Bearer lfy_sbx_…" \
  https://<host>/api/attestation/1111111111111111111111111111111111111111111111111111111111111111
```

An unrecognised `lfy_sbx_` key returns `401`; it never falls through to
production.

## Isolation

- Sandbox requests are answered from in-code fixtures (`lib/sandbox`) before
  any production dependency is called: no Soroban RPC, no Supabase, no
  production rate-limit rows. A sandbox key therefore cannot read production
  data, whatever hash it asks for.
- Fixture hashes are only resolved for sandbox keys; production callers get
  the normal on-chain lookup.
- Every sandbox response carries `"sandbox": true` and the
  `X-Lafiya-Sandbox: true` header.

These guarantees are covered by `lib/sandbox/sandbox.test.ts`.

## Researcher sandbox (vulnerability rewards)

Researchers accepted into the programme get a dedicated sandbox that mirrors
the most security-sensitive surfaces — capabilities, row-level security (RLS)
and payouts — using synthetic data only. It is separate from the integrator
sandbox above and from production.

### Requesting access

1. Read the programme policy in [`SECURITY.md`](../SECURITY.md) and confirm the
   surface you intend to test is in scope.
2. Email the security contact listed in `SECURITY.md` from the address you will
   use for the report, with your GitHub handle and the surfaces you plan to
   probe (capabilities, RLS, payouts, or a combination).
3. Maintainers issue a researcher sandbox key (prefix `lfy_sbx_`, same
   transport as the integrator sandbox) and add it to
   `LAFIYA_SANDBOX_API_KEYS`. Access is time-boxed and revoked when the report
   is closed.

### What the researcher sandbox provides

- **Synthetic data only.** Fixture patients, records and attestations are
  generated; no production row is ever copied in.
- **Test capabilities.** Capability grants can be minted, delegated and revoked
  against fixture principals, so you can exercise grant/revoke flows and
  capability checks without affecting real accounts.
- **RLS test rows.** Fixture tenants and users let you attempt cross-tenant
  reads and writes; every query runs against the sandbox database, never the
  production one.
- **Payout fixtures.** Payout and settlement flows run against simulated
  balances and a stub settlement backend. No mainnet funds, keys or Soroban
  transactions are involved.

### Isolation guarantees

- Sandbox requests are answered from in-code fixtures (`lib/sandbox`) before any
  production dependency is called: no Soroban RPC, no production Supabase, no
  production rate-limit rows.
- Fixture hashes and fixture principals are only resolved for sandbox keys;
  production callers get the normal on-chain and database lookups.
- Every sandbox response carries `"sandbox": true` and the
  `X-Lafiya-Sandbox: true` header.
- Sandbox traffic has its own rate limiter (see below), separate from
  production.

### Rules of engagement

- **No real patient data.** Do not attempt to access, exfiltrate or infer
  production PHI. If you encounter real data in the sandbox, stop and report it
  immediately.
- **No mainnet funds.** Do not send mainnet transactions, use real keys, or
  attempt to move real value. Payout testing is limited to fixtures.
- **Stay in scope.** Only test the surfaces listed in `SECURITY.md`. Denial of
  service, social engineering and physical attacks are out of scope.
- **Report privately.** Do not disclose findings publicly before the advisory
  is published. Use the private advisory intake described below.

### Intake and triage SLAs

Reports are submitted through GitHub private security advisories (the "Report a
vulnerability" flow on the repository). The intake automation opens a private
advisory and records timestamps so the following SLAs can be measured:

| Stage                          | Target                                   |
| ------------------------------ | ---------------------------------------- |
| Acknowledgement of report      | within 2 business days                   |
| Initial triage / severity call | within 5 business days                   |
| Status update cadence          | at least every 7 days while open         |
| Fix or mitigation plan         | within 30 days of triage (severity-based)|

Researchers can see the current state of their advisory in GitHub; SLA
breaches are tracked by maintainers and reviewed in the security sync.

## Fixtures

| Record hash          | `state`    | `verified` | `attestation`                  | `simulatedWebhook.type` |
| -------------------- | ---------- | ---------- | ------------------------------ | ----------------------- |
| `1` × 64             | `verified` | `true`     | object, `timestamp` 1767225600 | `attestation.verified`  |
| `2` × 64             | `revoked`  | `false`    | object, `timestamp` 1767312000 | `attestation.revoked`   |
| `3` × 64             | `archived` | `false`    | object, `timestamp` 1767398400 | `attestation.archived`  |
| `4` × 64             | `pending`  | `false`    | `null`                         | `attestation.pending`   |
| any other valid hash | `null`     | `false`    | `null`                         | `null`                  |

Example response for the verified fixture:

```json
{
  "sandbox": true,
  "verified": true,
  "state": "verified",
  "attestation": {
    "recordHash": "1111…1111",
    "attester": "GSANDBOXATTESTOR000000000000000000000000000000000000000",
    "timestamp": 1767225600,
    "state": "verified"
  },
  "ledger": null,
  "rpcHost": null,
  "simulatedWebhook": {
    "sandbox": true,
    "type": "attestation.verified",
    "recordHash": "1111…1111",
    "occurredAt": 1767225600
  }
}
```

`simulatedWebhook` is the payload your webhook endpoint would receive for that
lifecycle event, so handlers can be tested without a live delivery.

## Rate limits

Sandbox traffic has its own limiter, separate from production:
**60 requests per minute per sandbox key** (fixed window, per instance). Over
the limit the API returns `429` with `"sandbox": true` and `secondsRemaining`.
Production lookups keep the IP-based backoff described in `lib/rate-limit.ts`.
