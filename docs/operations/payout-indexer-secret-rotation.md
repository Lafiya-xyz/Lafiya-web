# Payout Indexer Cron Secret Rotation

The payout-indexer endpoint accepts the current `PAYOUT_INDEXER_CRON_SECRET` and, when configured, `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS`. Keep both values in the deployment secret store; never put bearer tokens in source control, logs, issue comments, or monitoring annotations.

## Rotate Without Interrupting Scheduled Runs

1. Generate a new random secret with at least 32 characters, for example `openssl rand -hex 32`.
2. Set `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS` to the existing current secret while leaving `PAYOUT_INDEXER_CRON_SECRET` unchanged. Deploy and verify the indexer endpoint remains healthy.
3. Set `PAYOUT_INDEXER_CRON_SECRET` to the new secret and deploy, keeping the previous secret configured. The old and new tokens are both accepted during this window.
4. Update the scheduler to send the new secret in the `Authorization: Bearer <token>` header. Confirm scheduled runs succeed with the new token.
5. Remove `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS` and deploy after all callers have switched. The old token will then be rejected.

If a deployment or scheduler update fails, retain both configured values and restore the scheduler to whichever token is known to work. Do not remove the previous secret until all callers have switched.

## Verify Configuration

- Both configured secrets must be at least 32 characters.
- The previous secret is optional and only applies while the payout indexer is enabled.
- Requests with a missing, malformed, or unrecognized bearer token receive `401`.
- The readiness endpoint is unauthenticated and does not use these secrets.