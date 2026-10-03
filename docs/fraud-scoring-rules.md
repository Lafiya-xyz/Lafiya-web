# CHW Fraud Scoring Rules

Implements the "flag suspicious CHWs / hold payouts pending review" issue.
`protocol_quarantine` previously had one feeder (`quarantine_protocol_event`,
called only for malformed on-chain events); this adds the first
fraud-specific feeder.

## Signals and thresholds

Defined in `supabase/migrations/20260928120000_chw_fraud_scoring.sql`
(`fraud_rule_definitions` table) and mirrored for pure-function testing in
`lib/chw-protocol/fraud-scoring.ts`.

| Rule | Signal family | Default threshold | Source view |
|---|---|---|---|
| `burst_velocity_v1` | Burst velocity | >8 verification intents from one CHW in a rolling 1-hour bucket | `mv_chw_verification_velocity` |
| `shared_device_ip_v1` | Shared device/IP | Same `device_id` or `ip_address` used by 2+ distinct CHW identities | `mv_shared_device_ip_clusters` |
| `near_duplicate_v1` | Near-duplicate records | Same CHW resubmits the same `revision_id` within 10 minutes | `mv_near_duplicate_intents` |
| `mutual_graph_v1` | Mutual-verification graph clusters | 2+ CHWs referencing each other's revisions within a 24h window | `mv_mutual_verification_clusters` |

Thresholds are stored as data (`fraud_rule_definitions.threshold jsonb`), not
hardcoded, so product owners can tune them without a migration once a
reviewer UI exists. **These starting thresholds are placeholders** pending
the "define signals and thresholds with product owners" step the issue
calls for — treat them as a shadow-mode baseline, not a final calibration.

## Shadow mode

Every rule defaults to `shadow_mode = true`. `evaluate_fraud_rules()`
always writes a `chw_fraud_flags` row when a rule fires, but only calls
`quarantine_protocol_event('fraud', ...)` (which blocks settlement — see
`docs/adr-002-chw-verification-protocol.md` for how `protocol_quarantine`
gates the payout pipeline) when the specific rule's `shadow_mode = false`.
This means:

- Shadow-mode rules are fully observable (`chw_fraud_flags.status =
  'shadow'`) without ever holding a real payout.
- Promoting a rule to blocking is a single `update fraud_rule_definitions
  set shadow_mode = false where rule_code = ...` — no code deploy.
- Precision on seeded synthetic fraud (the acceptance criterion) is
  measured by running `evaluate_fraud_rules()` against a fixture dataset
  seeded with both known-fraudulent and known-clean CHW activity and
  comparing `chw_fraud_flags` output to the seeded labels. The pure
  TypeScript detectors in `lib/chw-protocol/fraud-scoring.ts` (same logic,
  no DB required) are covered by synthetic fixtures per rule in
  `fraud-scoring.test.ts` — each test both demonstrates a rule catching a
  seeded fraud pattern and *not* catching a seeded clean pattern, which is
  the basis for a future precision report once run against production-scale
  data.

## Reviewer workflow and audit trail

`chw_fraud_flags` carries `status` (`shadow -> quarantined -> released |
voided`), `reviewed_by`, `reviewed_at`, and `review_note` — every reviewer
action is a row update on an existing flag, never a delete, so the audit
trail is the table's own history. `lib/chw-protocol/fraud-scoring.ts`
exports `buildReviewerAuditEntry()` for the admin endpoint (an
`app/api/admin/quarantine/*` route consuming this table is left as
follow-up wiring, out of scope for this change) to construct a consistent
audit record when a reviewer releases or voids a flag.

## Privacy

All signals operate on `chw_id`, `device_id`, `ip_address`, `revision_id`,
and timestamps — never on patient health record content (blood group,
genotype, allergies, medications, conditions). No PHI is read, logged, or
persisted by this pipeline. `device_id`/`ip_address` are new columns added
to `verification_intents` in this change specifically to support fraud
aggregation; they are not exposed on any patient-facing surface.

## Testing

- `lib/chw-protocol/fraud-scoring.test.ts` — synthetic fraud/clean fixture
  pairs per rule (burst velocity, shared device/IP, near-duplicate).
- Not run as part of this change (per task constraints). Before merge, a
  maintainer should run the migration against a scratch database, seed
  fixture data, run `select * from evaluate_fraud_rules();`, and confirm
  `npm run lint && npm run typecheck && npm test` pass, plus an integration
  test exercising the migration end-to-end (add to
  `tests/integration/chw-verification-protocol.test.ts` conventions).

## Out of scope

ML-based scoring (rules first, per the issue), the reviewer admin UI itself,
and the `mutual_graph_v1` TypeScript mirror (SQL-only for now — the graph
clustering is naturally set-based and cheaper to express and iterate on in
SQL than to duplicate in TypeScript) are out of scope for this change.
