# Email deliverability: bounces, complaints and DNS alignment (#802)

## Suppression list

`POST /api/notifications/email-events` ingests provider bounce/complaint
webhooks. The raw body must carry an HMAC-SHA256 signature
(`X-Webhook-Signature`, hex or base64, optional `sha256=` prefix) keyed with
`EMAIL_WEBHOOK_SECRET`. Invalid signatures return 401 and are logged with
only `hasSignature` and byte length — never payload content.

Addresses are stored in `email_suppressions` as SHA-256 hashes of the
lower-cased address.

| Event        | Effect                                                            |
| ------------ | ----------------------------------------------------------------- |
| Hard bounce  | Permanent suppression until manual release                        |
| Complaint    | Permanent suppression until manual release; never bypassed        |
| Soft bounce  | Counted; after 3 consecutive soft bounces suppressed for 72 hours |

`sendNotification` checks the list before every email send. **Transactional
exceptions** (`TRANSACTIONAL_EXCEPTIONS` in `lib/notifications/suppression.ts`)
may bypass a *soft-bounce* suppression only; hard bounces and complaints are
never bypassed.

Manual release: `releaseEmailSuppression(email, staffUserId)` — use after the
patient confirms the address is fixed. Patients with an active suppression see
"Your email may be unreachable" on their profile, pointing them to SMS.

## SPF / DKIM / DMARC expectations

- **SPF**: the sending domain's TXT record includes the provider (e.g.
  `include:sendgrid.net`) and ends in `-all` or `~all`.
- **DKIM**: provider CNAME/TXT selectors are published and signing uses the
  sending domain (`d=` aligned with `From:`).
- **DMARC**: `_dmarc.<domain>` exists with `p=quarantine` or `p=reject`, and
  `adkim`/`aspf` alignment (relaxed is acceptable).

Verify with:

```sh
node scripts/verify-email-dns.mjs <domain> [dkim-selector ...]
```

The script exits non-zero if any check fails.
