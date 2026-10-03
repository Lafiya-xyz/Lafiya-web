# Funder Report Schema (v1)

Implements the "generate monthly funder reports" issue: deterministic,
signed CSV/JSON reports of verified registrations and payouts per region.

## Schema (version 1)

```json
{
  "schemaVersion": 1,
  "period": "2026-09",
  "rows": [
    {
      "region": "Lagos",
      "verifiedRegistrations": 42,
      "payoutsCount": 40,
      "payoutsTotalUsdc": "412.5000000",
      "transactionHashes": ["<64-char hex hash>", "..."]
    }
  ]
}
```

- `period` is a UTC calendar month (`YYYY-MM`); a report never spans a
  partial UTC day at either boundary.
- `payoutsTotalUsdc` is a fixed 7-decimal-place string (USDC's native
  Stellar precision), computed with integer/BigInt arithmetic
  (`sumFixedDecimal` in `funder-report.ts`) — never floating point — so
  summation order cannot change the result.
- `rows` is sorted by `region` (ASCII ascending); `transactionHashes` within
  a row is sorted and de-duplicated. Both are required for byte-for-byte
  reproducibility regardless of the order records were read from the
  database.
- The full human-readable output (`generatedAt` timestamp, `format`) is
  produced by `serializeReportJson`/`serializeReportCsv` in
  `lib/stellar/payout-indexer/funder-report.ts`, but `generatedAt` is
  deliberately **excluded** from the bytes that get signed
  (`canonicalReportBytes`) — otherwise every re-generation of an identical
  report would produce a different, equally-valid-looking signature, which
  would defeat "reproducible byte-for-byte for a fixed dataset."

Schema changes bump `schemaVersion`; consumers (including
`scripts/verify-funder-report.mjs`) should reject an unrecognized version
rather than guess at field meaning.

## Signing

- Server-side Ed25519 keypair (`lib/stellar/payout-indexer/report-signing.ts`,
  built on `@stellar/stellar-sdk`'s `Keypair`, already a project dependency
  — no new crypto library introduced). The signing key is distinct from any
  on-chain payout/sponsor account; it only ever signs report bytes.
- The signer's public key (Stellar `G...` address format) should be
  published in `stellar.toml` (this repo does not yet have one — see
  `docs/anchor-offramp-spike.md`, which also touches `stellar.toml`) or, in
  the interim, directly in this doc once a real key is provisioned, so
  funders have an out-of-band source of truth for the public key rather
  than trusting whatever accompanies a given report download.
- `scripts/verify-funder-report.mjs` is the funder-facing verification
  script: given the canonical report JSON, the base64 signature, and the
  published public key, it reports OK/FAILED and exits non-zero on failure.
  It depends only on `@stellar/stellar-sdk`, so a funder can run it without
  access to this repository or database.

## Admin download endpoint

`GET /api/admin/funder-reports?period=YYYY-MM&format=json|csv`
(`app/api/admin/funder-reports/route.ts`) returns the report body, its
schema version, and the `(signature, signerPublicKey)` pair. Auth is a
placeholder bearer-token check (`lib/auth/admin-session.ts`) pending
wiring to this project's real admin auth. The data-loading seam
(`loadSettlementRecordsForPeriod`) is intentionally left unimplemented — it
needs a real query against `payout_obligations`/`payout_settlements`
filtered to `status = 'matched'` within the UTC month, joined to each
obligation's region attribute, and that query wasn't validated against a
live schema as part of this change.

## Privacy review

- Report rows contain: region name, aggregate counts, aggregate USDC
  totals, and on-chain transaction hashes.
- Report rows do **not** contain: CHW name/contact info, patient identity
  or any health record field (blood group, genotype, allergies,
  medications, conditions), device/IP data, or capability tokens.
- Transaction hashes and region aggregates are already public/pseudonymous
  by nature of being on a public ledger and a coarse geographic bucket —
  publishing them to a funder does not create a new disclosure beyond what
  the chain already exposes.
- **Conclusion: no PHI is present in a funder report.** This satisfies the
  "privacy review confirms there is no PHI" acceptance criterion for the
  schema as designed; a maintainer should still re-check this conclusion
  once `loadSettlementRecordsForPeriod` is wired to real queries, in case a
  future column addition accidentally pulls in more than region/counts/
  hashes.

## Testing

- `lib/stellar/payout-indexer/funder-report.test.ts` — golden-file
  determinism test (fixed dataset, shuffled/reversed input order, differing
  `generatedAt`, asserts identical canonical bytes and a specific expected
  row shape) and a sign-and-verify round trip (valid signature verifies;
  tampered bytes and wrong public key both fail verification).
- Not run as part of this change (per task constraints); a maintainer should
  run `npm run lint && npm run typecheck && npm test` and add an
  integration test once `loadSettlementRecordsForPeriod` is implemented
  against a real database.

## Out of scope

Automated emailing of reports to funders, and the real
`loadSettlementRecordsForPeriod` database query, are out of scope for this
change per the issue.
