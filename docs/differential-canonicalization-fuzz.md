# Differential canonicalization fuzzing (issue #958)

`npm run fuzz:differential` generates random synthetic records, canonicalizes
each one with `@lafiya/protocol` (reference) and with the verifier-side
implementation in `lib/records/canonicalization.ts`
(`canonicalizeEmergencyRecordVerifier`), and compares the outputs.

- Generator and runner: `packages/protocol/src/differentialFuzz.ts`
  (seeded mulberry32 PRNG, so a divergence is reproducible from its seed).
- CLI: `scripts/differential-fuzz.mjs` (`--cases`, `--seed`, `--write`).
- Nightly job: `.github/workflows/differential-fuzz.yml` (04:00 UTC). On a
  divergence it appends the case to
  `contracts/record-canonicalization-differential-v1.json`, commits it, and
  files a cross-repo issue with the report.
- Committed vectors are replayed by
  `lib/records/canonicalization.differential.test.ts`.

No PHI: every generated value is synthetic.
