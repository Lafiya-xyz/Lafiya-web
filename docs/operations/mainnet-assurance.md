# Production and mainnet assurance

This document is the operating contract for Lafiya releases. It is not a
claim of clinical validation, legal compliance, or mainnet approval. A gate is
open only when its evidence exists, is within its expiry period, and has the
named owner approval recorded in the release evidence bundle.

## Release identity and reproducibility

The supported toolchain is Node `24.14.0` and npm `11.9.0` (pinned in
`.nvmrc` and `package.json`). The canonical clean-checkout sequence is:

```bash
npm ci
npm run lint
npm run typecheck
npm run migration:lint
npm test
npm run build
npm run ci:check-clean-worktree
```

`npm ci` is mandatory in CI and release builds. Platform-specific Rolldown
bindings are direct optional dependencies so npm reliably installs the correct
binding on supported Linux, macOS, and Windows x64/arm64 runners. The supply
chain workflow also pins every Action to a commit SHA, checks those pins,
scans the repository for verified secrets, audits production dependencies,
creates a CycloneDX SBOM, and attests the SBOM provenance.

No build output, package-lock drift, generated source drift, or lint warning
may be accepted. The clean-worktree check runs after the build and fails on
changes to tracked files. `artifacts/` is intentionally ignored and may hold
only the SBOM; it must never contain patient data, bearer capabilities,
credentials, screenshots of real cards, or provider responses.

Dependency findings are triaged by the release owner: critical or actively
exploitable production findings block release; high findings require a patch
or a time-bounded, named exception; moderate findings are remediated within 30
days; low findings are reviewed quarterly. An exception records advisory,
affected path, mitigation, owner, and expiry in release evidence. It is never
a permanent ignore rule.

## Build provenance trust chain

Every release build produces signed SLSA build provenance for the deployable
artefacts, and the mainnet release gate refuses to promote anything whose
provenance cannot be verified. The trust chain is:

1. **Reviewed commit.** The release is cut from a commit that passed CI on the
   protected branch. The workflow records the commit SHA as the build identity.
2. **Build.** `.github/workflows/mainnet-release.yml` builds the application and
   packages the `.next` output as a tarball, alongside the CycloneDX SBOM.
3. **Attestation.** `actions/attest-build-provenance` signs provenance for both
   the `.next` tarball and the SBOM, binding each artefact's SHA-256 digest to
   the workflow, repository, and commit that produced it. The attestations are
   stored in the repository's attestation store.
4. **Verification.** `scripts/verify-release-gate.mjs` runs
   `gh attestation verify` against the artefact digest before promotion. The
   gate fails closed: a missing attestation, an attestation that does not match
   the artefact digest, or an attestation whose signer/workflow does not match
   the expected release identity all block the release.
5. **Promotion.** Only after the gate passes is the verified artefact promoted
   to the protected production/mainnet environment.

Provenance proves which workflow and commit produced an artefact; it does not
prove the artefact is free of defects. It complements, and does not replace,
the readiness checks, migration invariants, and named approvals above. The
verification step never logs artefact contents, credentials, or capability
tokens — only digests, workflow identity, and pass/fail outcomes.

## Runtime configuration and readiness

`lib/runtime-config.ts` validates all server configuration before traffic.
`instrumentation.ts` invokes it when each Node.js instance starts. It prevents:

- an unlabelled production process;
- mock attestations, testnet, incomplete protocol data, absent build identity,
  schema mismatch, or disabled Sentry in production/mainnet;
- live attestation without a valid Soroban contract identity;
- payout indexing without every Stellar, USDC, pool, cursor, and 32-character
  cron-secret value; and
- a disabled indexer or Sentry group that still has stale configuration.

Local mock mode must be explicit (`LAFIYA_DEPLOYMENT_ENV=development`,
`ATTESTATION_MODE=mock`) and cannot include a contract ID. `production` and
`mainnet` require the public Stellar network passphrase. Do not use production
as a synonym for staging or pilot; use the explicit `preview`, `staging`, or
`pilot` identity instead.

`GET /api/internal/readiness` is an unauthenticated, non-cacheable readiness
probe. It checks a bounded database query and returns only deployment identity,
build revision, expected schema compatibility, and component states. It never
returns a database URL, credentials, contract/address, key, capability,
record identifier, or patient-derived value. A database failure yields `503`;
process liveness is not readiness.

## Environment topology and promotion

| Environment        | Isolation requirement                                                                        | Network                                               | Promotion requirements                                 |
| ------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Preview            | dedicated Supabase project, storage, telemetry project, domain, and credentials              | testnet                                               | CI + readiness smoke only                              |
| Staging            | isolated from preview and pilot; production-shaped anonymized data only                      | testnet                                               | migration rehearsal + synthetic probes                 |
| Pilot              | isolated patient-support and telemetry scopes; no production treasury                        | testnet unless the approved pilot specifies otherwise | named clinical/support/security approval               |
| Production/mainnet | dedicated database, storage, domains, telemetry, contracts, wallets, cron keys, and treasury | public Stellar network                                | signed release gate and protected environment approval |

Promote one reviewed artifact/build revision through each stage. Database changes
use expand → compatible application deploy → checkpointed backfill → invariant
query → contract sequence. Roll back only code that remains schema-compatible;
otherwise roll forward with a compensating migration. Never delete revisions or
rewrite payout evidence to make a rollback appear clean.

Automatic halt criteria: readiness failure, migration invariant failure,
public-card availability breach, public-card p95 breach, indexer freshness
breach, payout reconciliation mismatch, or a failed synthetic capability probe.
The release owner records the halt, impact, and roll-forward/rollback decision.

## SLO and alert catalog

Only safe dimensions are permitted: route class, deployment, dependency class,
outcome class, status family, and a random per-request correlation ID. Never
use URLs, user/card/revision IDs, hashes, capabilities, addresses tied to a
patient, phone numbers, or health values as telemetry dimensions.

| SLI                                 | Objective / alert                                                | Source and aggregation                                   | Owner            | Privacy rationale                 |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- | ---------------- | --------------------------------- |
| Public emergency-card availability  | 99.9% successful live resolutions / page at <99.5% over 10 min   | synthetic and server route-class counters, 5-min windows | on-call platform | no card URL or identifier         |
| Public-card p95                     | <= 2.5s / warn at >2.5s for 15 min                               | route-class latency histogram                            | web on-call      | timings only                      |
| Attestation decision freshness      | 99% under 5 min when live / page at >15 min or provider failures | RPC outcome/latency + trust state age buckets            | protocol owner   | no commitment or record hash      |
| Offline envelope validation         | 99% safe-envelope render / investigate <99% daily                | client aggregate counters from synthetic fixtures only   | web owner        | no envelope or capability payload |
| Indexer lag                         | <= 5 ledgers / page at >20 ledgers for 10 min                    | safe checkpoint/head delta                               | indexer owner    | cursor and ledger bucket only     |
| Payout reconciliation               | zero unmatched eligible obligations / immediate page on mismatch | aggregate reconciliation query                           | treasury owner   | counts/status only                |
| Auth and export/deletion completion | 99.5% successful / page on sustained failure                     | route-class outcomes                                     | privacy owner    | no account identifier             |

Alerts are symptom-based, grouped by deployment + component, deduplicated for
30 minutes, and suppressed only during a documented maintenance window. Every
page links to a runbook with impact, confirmation query, safe mitigation,
rollback/roll-forward point, owner, and escalation path. Sentry is configured
with `sendDefaultPii: false`, event and breadc

/* … truncated 4987 chars — edit only what you need near the top … */
