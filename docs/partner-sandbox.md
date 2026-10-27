# Partner sandbox

Integrators can exercise the verifier API (`GET /api/attestation/{recordHash}`)
against synthetic data without touching patient records or mainnet funds.

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
