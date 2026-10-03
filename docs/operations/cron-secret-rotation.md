# Rotating the payout-indexer cron secret

`POST /api/internal/payout-indexer` is reachable from the internet and is
authorized only by a bearer token. The route verifies it with
[`verifyBearer`](../../lib/security/bearer.ts), which SHA-256-hashes the
presented token and every configured secret and compares the digests with
`crypto.timingSafeEqual`. Two secrets can be valid at the same time, so the
secret can be rotated with no downtime and no failed cron runs.

| Variable                              | Role                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYOUT_INDEXER_CRON_SECRET`          | Current secret. Required when the indexer is enabled. Minimum 32 characters.                                                                                                            |
| `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS` | The secret being retired. Set **only** during a rotation window. Minimum 32 characters and must differ from the current secret. It is rejected at startup when the indexer is disabled. |

Neither value is ever logged, returned by readiness, or included in
`RuntimeConfigError` messages.

## Procedure

1. **Generate a new secret** on a trusted machine:

   ```bash
   openssl rand -hex 32
   ```

2. **Open the rotation window.** In the app's deployment secrets:
   - set `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS` to the value that is **currently**
     in `PAYOUT_INDEXER_CRON_SECRET`;
   - set `PAYOUT_INDEXER_CRON_SECRET` to the **new** secret.

   Redeploy. Both secrets now authorize requests, so the scheduler, which
   still sends the old secret, keeps working.

3. **Update the caller.** Change the bearer token in the scheduler's (cron
   job's) `Authorization` header to the new secret. Wait for at least one
   successful run (HTTP 200) that uses it.

4. **Close the rotation window.** Remove `PAYOUT_INDEXER_CRON_SECRET_PREVIOUS`
   from the deployment secrets and redeploy. The old secret now gets `401`.

5. **Verify.** A request with the old secret must return `401`:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H "Authorization: Bearer $OLD_SECRET" \
     https://<host>/api/internal/payout-indexer
   ```

Keep the window as short as practical, ideally one scheduler interval. For a
suspected **leak**, skip the window: set only the new
`PAYOUT_INDEXER_CRON_SECRET`, redeploy, and update the scheduler. Missed runs
are safe because the indexer resumes from its durable cursors.

## Failure modes

| Symptom                                                      | Cause                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Boot fails with `CRON_SECRET_PREVIOUS_TOO_SHORT`             | The previous secret is under 32 characters.                                                             |
| Boot fails with `CRON_SECRET_PREVIOUS_MATCHES_CURRENT`       | Step 2 was only half-applied: both variables hold the same value.                                       |
| Boot fails with `PAYOUT_INDEXER_DISABLED_WITH_CONFIGURATION` | A previous secret is set while `PAYOUT_INDEXER_ENABLED=false`.                                          |
| Scheduler gets `401` during the window                       | The scheduler sends a value that is neither secret. Check for whitespace or a missing `Bearer ` prefix. |
