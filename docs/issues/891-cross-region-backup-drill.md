# #891 — Cross-region encrypted backups + RPO/RTO restore drill

## Built in this change

- `scripts/backup/verify-backup-drill.mjs` — measures RPO (backup completion →
  restore start) and RTO (restore start → restore complete) against the
  targets (RPO ≤ 15 min, RTO ≤ 4 h) and writes a CTL-016 evidence record in the
  `compliance-evidence/YYYY-MM-DD/` format. Exits 1 on a target breach so the
  drill job fails loudly while still producing evidence.

## Remaining work (in order)

1. **Backup job** — `.github/workflows/backup-cross-region.yml` (nightly cron):
   `pg_dump --format=custom` from `DIRECT_URL`, encrypt with `age` using a
   public key whose private half is held outside the primary provider
   (separate KMS/HSM, not Supabase/Vercel), upload to a secondary-region
   bucket with object lock (compliance mode) and a 35-day retention.
   Secrets: `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_*` (secondary region only).
2. **Drill job** — `.github/workflows/restore-drill-backup.yml` (weekly):
   download latest object, decrypt with `BACKUP_AGE_IDENTITY`, restore into a
   throwaway Postgres service, run `scripts/exit-strategy/verify-vanilla-restore.mjs`,
   then call `node scripts/backup/verify-backup-drill.mjs --backup-completed-at …
   --restore-started-at … --restore-completed-at … --out compliance-evidence/…`
   and commit the record (same pattern as `compliance-evidence.yml`).
3. **Control catalog** — add CTL-016 to `docs/compliance/control-catalog.md`
   and to `REQUIRED_CONTROLS` in `scripts/collect-compliance-evidence.mjs`.
4. **Residency** — add the backup bucket as a processor entry in
   `compliance/residency.json` with NDPA s.41 legal basis and approved
   secondary region; document the review in `docs/operations/backup-restore.md`.
5. **Docs** — `docs/operations/backup-restore.md`: key custody, object-lock
   retention, drill cadence, gap follow-ups.

## Done when

- Nightly encrypted backup lands in the secondary region with object lock.
- Weekly drill produces a committed CTL-016 record with measured RPO/RTO.
- Any breach is documented with a follow-up issue and linked from the record.
