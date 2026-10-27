# Partner API keys, quotas and usage (#809)

## Keys
- Format: `lfy_<12 hex prefix>_<43 char secret>`, sent as `Authorization: Bearer <key>`.
- Shown **once** at issue time (`issuePartnerKey`); only the SHA-256 hash is stored.
- Scoped: the attestation lookup requires `attestation:read`.
- Rotation (`rotatePartnerKey`) issues a new key and sets `expires_at` on the
  old one (default overlap 7 days) so integrations can switch without downtime.

## Quotas
Each key has `rate_per_minute` and `monthly_quota`, enforced atomically in
Postgres (`partner_api_consume`) so concurrent requests across instances can
never exceed them. Rejected requests are not charged.

## Error semantics
| Status | Meaning |
| --- | --- |
| `401` | Missing, malformed, unknown, revoked or expired key |
| `403` | Key lacks the endpoint's scope |
| `429` | Per-minute or monthly quota exhausted |

Every metered response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` (seconds) for the tighter of the two windows. A `429` adds
`Retry-After` (seconds until the exhausted window resets — up to the start
of next UTC month for the monthly quota).

## Usage reporting
Counters are kept per key, UTC month, endpoint **template** and status class
(`2xx`…`5xx`). No record hashes, IPs or patient identifiers are stored.
- Partner: `GET /api/partner/usage?period=YYYY-MM` (own key).
- Admin: `GET /api/admin/partner-usage?period=YYYY-MM[&partner=<id>]`.
